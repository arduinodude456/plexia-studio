import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { ClassSession, Presentation, SessionBundle, SessionGroupAssignment, StudentResponse } from "./model";

const env = import.meta.env;
const supabaseUrl = env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);
export const supabase: SupabaseClient | null = hasSupabaseConfig
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      realtime: { params: { eventsPerSecond: 8 } },
    })
  : null;

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error("Supabase ist noch nicht konfiguriert. VITE_SUPABASE_URL und VITE_SUPABASE_ANON_KEY fehlen.");
  return supabase;
}

function mapSession(row: Record<string, unknown>): ClassSession {
  return {
    id: String(row.id),
    presentationId: String(row.presentation_id),
    joinCode: String(row.join_code ?? ""),
    status: row.status as ClassSession["status"],
    currentSlideIndex: Number(row.current_slide_index ?? 0),
    activityStatus: (row.activity_status ?? "idle") as ClassSession["activityStatus"],
    createdAt: String(row.created_at ?? new Date().toISOString()),
  };
}

function mapResponse(row: Record<string, unknown>): StudentResponse {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    slideId: String(row.slide_id),
    participantId: String(row.participant_id),
    nickname: String(row.nickname ?? "Schüler/in"),
    answerText: String(row.answer_text ?? ""),
    answerJson: (row.answer_json ?? {}) as Record<string, unknown>,
    mediaPath: row.media_path ? String(row.media_path) : null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    score: row.score == null ? null : Number(row.score),
    feedback: row.feedback == null ? null : String(row.feedback),
    reviewed: Boolean(row.reviewed),
  };
}

function mapGroupAssignment(row: Record<string, unknown>): SessionGroupAssignment {
  return {
    sessionId: String(row.session_id),
    slideId: String(row.slide_id),
    userId: String(row.user_id),
    groupNumber: Number(row.group_number),
    assignedAt: String(row.assigned_at ?? new Date().toISOString()),
  };
}
function withTimeout<T>(promise: PromiseLike<T>, message: string, milliseconds = 10000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
    Promise.resolve(promise).then((value) => { window.clearTimeout(timer); resolve(value); }, (error: unknown) => { window.clearTimeout(timer); reject(error); });
  });
}
export async function signInTeacher(email: string, password: string) {
  const client = requireSupabase();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const { data: profile, error: profileError } = await client.from("profiles").select("role").eq("user_id", data.user.id).maybeSingle();
  if (profileError) throw profileError;
  if (profile?.role !== "teacher") {
    await client.auth.signOut();
    throw new Error("Dieses Konto ist als Schülerkonto eingerichtet. Bitte nutze ein Lehrkraftkonto oder erstelle im PLEXIA Studio ein neues Lehrkraftkonto.");
  }
  return data.user;
}

export async function signUpTeacher(email: string, password: string) {
  const client = requireSupabase();
  const { data, error } = await client.auth.signUp({ email, password, options: { data: { account_type: "teacher" } } });
  if (error) throw error;
  return data;
}

export async function signOut() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getCurrentUser() {
  if (!supabase) return null;
  const { data, error } = await withTimeout(supabase.auth.getUser(), "Die Supabase-Verbindung antwortet nicht. Bitte prüfe deine Internetverbindung und lade die Seite erneut.");
  if (error && error.name !== "AuthSessionMissingError") throw error;
  if (data.user) {
    const { data: profile, error: profileError } = await withTimeout(supabase.from("profiles").select("role").eq("user_id", data.user.id).maybeSingle(), "Das Lehrkraftprofil konnte nicht geladen werden. Bitte lade die Seite erneut.");
    if (profileError) throw profileError;
    if (profile?.role !== "teacher") {
      await supabase.auth.signOut();
      throw new Error("Dieses Konto ist als Schülerkonto eingerichtet. Bitte nutze ein Lehrkraftkonto oder erstelle im PLEXIA Studio ein neues Lehrkraftkonto.");
    }
  }
  return data.user;
}

export async function listPresentations(): Promise<Presentation[]> {
  const client = requireSupabase();
  const { data, error } = await withTimeout(client.from("presentations").select("data").order("updated_at", { ascending: false }), "Die Präsentationen konnten nicht geladen werden. Bitte prüfe die Supabase-Verbindung.");
  if (error) throw error;
  return (data ?? []).map((row: { data: Presentation }) => row.data);
}

export async function savePresentation(presentation: Presentation): Promise<void> {
  const client = requireSupabase();
  const { data: userResult, error: userError } = await client.auth.getUser();
  if (userError) throw userError;
  if (!userResult.user) throw new Error("Bitte melde dich an, um die Präsentation in der Cloud zu speichern.");
  const next = { ...presentation, updatedAt: new Date().toISOString() };
  const payload = {
    id: next.id,
    owner_id: userResult.user.id,
    title: next.title,
    description: next.description,
    data: next,
    updated_at: next.updatedAt,
  };
  const write = () => client.from("presentations").upsert(payload, { onConflict: "id" });
  let result = await write();
  if (result.error && ["401", "42501", "PGRST301"].includes(String(result.error.code))) {
    await client.auth.refreshSession();
    result = await write();
  }
  if (result.error) {
    const code = result.error.code ? ` [${result.error.code}]` : "";
    throw new Error(`Cloudspeicherung fehlgeschlagen: ${result.error.message || "Unbekannter Supabase-Fehler"}${code}`);
  }
}

export async function uploadPresentationMedia(presentationId: string, file: File): Promise<string> {
  if (!presentationId || /[\\/]/.test(presentationId)) throw new Error("Die Präsentations-ID ist ungültig.");
  const client = requireSupabase();
  const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm"];
  if (!allowed.includes(file.type)) throw new Error("Verwende PNG, JPEG, WebP, GIF, MP4 oder WebM.");
  if (file.size > 50 * 1024 * 1024) throw new Error("Die Datei darf höchstens 50 MB groß sein.");
  const { data: authData, error: authError } = await client.auth.getUser();
  if (authError) throw authError;
  if (!authData.user) throw new Error("Bitte melde dich an, um Medien sicher hochzuladen.");
  if (/[\\/]/.test(authData.user.id)) throw new Error("Die Konto-ID ist ungültig.");
  const extension = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  const path = `${authData.user.id}/${presentationId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await client.storage.from("presentation-media").upload(path, file, {
    cacheControl: "3600", upsert: false, contentType: file.type,
  });
  if (error) throw error;
  return path;
}

export async function createSignedPresentationUrl(path: string, expiresIn = 3600): Promise<string> {
  const client = requireSupabase();
  const { data, error } = await client.storage.from("presentation-media").createSignedUrl(path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type PrivateMediaBucket = "presentation-media" | "student-uploads";

async function listPrivateStorageFiles(bucket: PrivateMediaBucket, prefix: string): Promise<string[]> {
  const client = requireSupabase();
  const files: string[] = [];
  const pageSize = 100;
  async function walk(path: string, depth: number): Promise<void> {
    if (depth > 3) throw new Error("Der private Medienordner hat eine unerwartet tiefe Struktur.");
    for (let offset = 0; ; offset += pageSize) {
      if (offset >= 10_000 * pageSize) throw new Error("Der private Medienordner enthält zu viele Dateien für eine sichere Bereinigung.");
      const { data, error } = await client.storage.from(bucket).list(path, {
        limit: pageSize, offset, sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`Private Medien in ${bucket} konnten nicht sicher aufgelistet werden: ${error.message}`);
      const entries = data ?? [];
      for (const entry of entries) {
        if (!entry.name || entry.name === "." || entry.name === ".." || entry.name.includes("/") || entry.name.includes("\\")) {
          throw new Error("Der private Medienordner enthält einen ungültigen Dateinamen.");
        }
        const objectPath = `${path}/${entry.name}`;
        if (entry.id) {
          files.push(objectPath);
          if (files.length > 20_000) throw new Error("Die Präsentation enthält zu viele private Dateien für eine sichere Bereinigung.");
        } else {
          await walk(objectPath, depth + 1);
        }
      }
      if (entries.length < pageSize) break;
    }
  }
  await walk(prefix, 0);
  return files;
}

export async function deletePresentationStorage(presentationId: string): Promise<void> {
  const client = requireSupabase();
  if (!UUID_RE.test(presentationId)) throw new Error("Die Präsentations-ID ist ungültig; private Dateien wurden nicht gelöscht.");
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError) throw userError;
  if (!userData.user) throw new Error("Bitte melde dich als Lehrkraft an, um private Präsentationsdateien zu löschen.");

  const sessionIds: string[] = [];
  for (let from = 0; ; from += 500) {
    if (from >= 10_000) throw new Error("Zu viele Sitzungen hängen an dieser Präsentation; die sichere Löschung wurde abgebrochen.");
    const { data, error } = await client.from("class_sessions").select("id")
      .eq("presentation_id", presentationId).range(from, from + 499);
    if (error) throw new Error(`Die Klassensitzungen konnten vor der Medienbereinigung nicht geladen werden: ${error.message}`);
    for (const session of data ?? []) {
      if (!UUID_RE.test(String(session.id))) throw new Error("Eine Sitzungs-ID ist ungültig; private Dateien wurden nicht gelöscht.");
      sessionIds.push(String(session.id));
    }
    if (!data || data.length < 500) break;
  }

  const teacherFiles = await listPrivateStorageFiles("presentation-media", `${userData.user.id}/${presentationId}`);
  const studentFiles: string[] = [];
  for (const sessionId of sessionIds) {
    studentFiles.push(...await listPrivateStorageFiles("student-uploads", sessionId));
    if (teacherFiles.length + studentFiles.length > 20_000) throw new Error("Zu viele private Dateien hängen an dieser Präsentation; die sichere Löschung wurde abgebrochen.");
  }

  for (const [bucket, paths] of [["presentation-media", teacherFiles], ["student-uploads", studentFiles]] as const) {
    for (let index = 0; index < paths.length; index += 100) {
      const { error } = await client.storage.from(bucket).remove(paths.slice(index, index + 100));
      if (error) throw new Error(`Private Dateien in ${bucket} konnten nicht vollständig über Supabase Storage gelöscht werden: ${error.message}`);
    }
  }
}

export async function createClassSession(presentation: Presentation): Promise<ClassSession> {
  const client = requireSupabase();
  await savePresentation(presentation);
  const { data, error } = await client.from("class_sessions").insert({
    presentation_id: presentation.id,
    status: "live",
    current_slide_index: 0,
    activity_status: "running",
  }).select("id,presentation_id,join_code,status,current_slide_index,activity_status,created_at").single();
  if (error) throw error;
  return mapSession(data as Record<string, unknown>);
}

export async function updateClassSession(sessionId: string, patch: Partial<Pick<ClassSession, "status" | "currentSlideIndex" | "activityStatus">>): Promise<void> {
  const client = requireSupabase();
  const values: Record<string, unknown> = {};
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.currentSlideIndex !== undefined) values.current_slide_index = patch.currentSlideIndex;
  if (patch.activityStatus !== undefined) values.activity_status = patch.activityStatus;
  values.updated_at = new Date().toISOString();
  const { error } = await client.from("class_sessions").update(values).eq("id", sessionId);
  if (error) throw error;
}

export async function getSessionBundle(sessionId: string): Promise<SessionBundle> {
  const client = requireSupabase();
  const { data: sessionRow, error: sessionError } = await client.from("class_sessions")
    .select("id,presentation_id,join_code,status,current_slide_index,activity_status,created_at")
    .eq("id", sessionId).single();
  if (sessionError) throw sessionError;
  const { data: presentationRow, error: presentationError } = await client.from("presentations").select("data")
    .eq("id", sessionRow.presentation_id).single();
  if (presentationError) throw presentationError;
  return { session: mapSession(sessionRow as Record<string, unknown>), presentation: presentationRow.data as Presentation };
}

export async function joinClassSession(joinCode: string, nickname: string): Promise<SessionBundle> {
  const client = requireSupabase();
  const { data: current } = await client.auth.getSession();
  if (!current.session?.user.is_anonymous) {
    const { error: signOutError } = await client.auth.signOut();
    if (signOutError) throw signOutError;
  }
  const { error: signInError } = await client.auth.signInAnonymously({ options: { data: { account_type: "student" } } });
  if (signInError) throw signInError;
  const { data, error } = await client.rpc("student_join_classroom", {
    p_join_code: joinCode.trim().toUpperCase(),
    p_nickname: nickname.trim().slice(0, 24),
  });
  if (error) throw error;
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") throw new Error(data.error);
  const bundle = data as { session_id?: string; session?: Record<string, unknown>; presentation?: Presentation };
  if (bundle?.session && bundle.presentation) {
    return { session: mapSession(bundle.session), presentation: bundle.presentation };
  }
  if (!bundle?.session_id) throw new Error("Der Zugangscode wurde nicht gefunden oder die Sitzung ist beendet.");
  return getSessionBundle(bundle.session_id);
}

export async function submitResponse(input: {
  sessionId: string;
  slideId: string;
  nickname: string;
  answerText?: string;
  answerJson?: Record<string, unknown>;
  mediaPath?: string;
}): Promise<StudentResponse> {
  const client = requireSupabase();
  const { data: userResult, error: userError } = await client.auth.getUser();
  if (userError) throw userError;
  if (!userResult.user?.is_anonymous) throw new Error("Schülerantworten müssen aus einer anonymen Teilnahmesitzung gesendet werden.");
  const editable = {
    answer_text: input.answerText ?? "",
    answer_json: input.answerJson ?? {},
    ...(input.mediaPath ? { media_path: input.mediaPath } : {}),
  };
  const existing = await client.from("student_responses").select("id")
    .eq("session_id", input.sessionId).eq("slide_id", input.slideId)
    .eq("participant_id", userResult.user.id).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    const { data, error } = await client.from("student_responses").update(editable)
      .eq("id", existing.data.id).eq("participant_id", userResult.user.id)
      .select("id,session_id,slide_id,participant_id,nickname,answer_text,answer_json,media_path,created_at,score,feedback,reviewed").single();
    if (error) throw error;
    return mapResponse(data as Record<string, unknown>);
  }
  const { data, error } = await client.from("student_responses").insert({
    session_id: input.sessionId,
    slide_id: input.slideId,
    participant_id: userResult.user.id,
    nickname: input.nickname.trim().slice(0, 24),
    ...editable,
  }).select("id,session_id,slide_id,participant_id,nickname,answer_text,answer_json,media_path,created_at,score,feedback,reviewed").single();
  if (error?.code === "23505") {
    const raced = await client.from("student_responses").select("id")
      .eq("session_id", input.sessionId).eq("slide_id", input.slideId)
      .eq("participant_id", userResult.user.id).maybeSingle();
    if (raced.error) throw raced.error;
    if (raced.data) {
      const corrected = await client.from("student_responses").update(editable)
        .eq("id", raced.data.id).eq("participant_id", userResult.user.id)
        .select("id,session_id,slide_id,participant_id,nickname,answer_text,answer_json,media_path,created_at,score,feedback,reviewed").single();
      if (corrected.error) throw corrected.error;
      return mapResponse(corrected.data as Record<string, unknown>);
    }
  }
  if (error) throw error;
  return mapResponse(data as Record<string, unknown>);
}

export async function getStudentResponse(sessionId: string, slideId: string): Promise<StudentResponse | null> {
  const client = requireSupabase();
  const { data: userResult, error: userError } = await client.auth.getUser();
  if (userError) throw userError;
  if (!userResult.user?.is_anonymous) return null;
  const { data, error } = await client.from("student_responses")
    .select("id,session_id,slide_id,participant_id,nickname,answer_text,answer_json,media_path,created_at,score,feedback,reviewed")
    .eq("session_id", sessionId).eq("slide_id", slideId)
    .eq("participant_id", userResult.user.id).maybeSingle();
  if (error) throw error;
  return data ? mapResponse(data as Record<string, unknown>) : null;
}

export async function uploadStudentPhoto(sessionId: string, file: File): Promise<string> {
  const client = requireSupabase();
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Dieses Bildformat wird nicht unterstützt. Bitte wähle PNG, JPEG oder WebP; HEIC kann hier nicht hochgeladen werden.");
  if (file.size > 12 * 1024 * 1024) throw new Error("Das Foto darf höchstens 12 MB groß sein.");
  const { data: userResult, error: userError } = await client.auth.getUser();
  if (userError) throw userError;
  if (!userResult.user) throw new Error("Teilnahmesitzung abgelaufen. Bitte tritt erneut bei.");
  const extension = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
  const path = `${sessionId}/${userResult.user.id}/${crypto.randomUUID()}.${extension}`;
  const { error } = await client.storage.from("student-uploads").upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
  if (error) throw error;
  return path;
}

export async function createSignedStudentPhotoUrl(path: string, expiresIn = 900): Promise<string> {
  const client = requireSupabase();
  const { data, error } = await client.storage.from("student-uploads").createSignedUrl(path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

export async function listSessionResponses(sessionId: string): Promise<StudentResponse[]> {
  const client = requireSupabase();
  const { data, error } = await client.from("student_responses").select("id,session_id,slide_id,participant_id,nickname,answer_text,answer_json,media_path,created_at,score,feedback,reviewed")
    .eq("session_id", sessionId).order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => mapResponse(row));
}

export async function listGroupAssignments(sessionId: string, slideId?: string): Promise<SessionGroupAssignment[]> {
  const client = requireSupabase();
  let query = client.from("session_group_assignments")
    .select("session_id,slide_id,user_id,group_number,assigned_at")
    .eq("session_id", sessionId)
    .order("group_number", { ascending: true })
    .order("assigned_at", { ascending: true });
  if (slideId) query = query.eq("slide_id", slideId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row) => mapGroupAssignment(row as Record<string, unknown>));
}

export async function saveGroupAssignments(sessionId: string, slideId: string, assignments: Record<string, number>): Promise<void> {
  const client = requireSupabase();
  const rows = Object.entries(assignments).map(([userId, groupNumber]) => ({
    session_id: sessionId,
    slide_id: slideId,
    user_id: userId,
    group_number: Math.max(1, Math.trunc(groupNumber)),
  }));
  const { error: deleteError } = await client.from("session_group_assignments")
    .delete().eq("session_id", sessionId).eq("slide_id", slideId);
  if (deleteError) throw deleteError;
  if (!rows.length) return;
  const { error } = await client.from("session_group_assignments").insert(rows);
  if (error) throw error;
}

export async function getMyGroupAssignment(sessionId: string, slideId: string): Promise<SessionGroupAssignment | null> {
  const client = requireSupabase();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError) throw userError;
  if (!userData.user) return null;
  const { data, error } = await client.from("session_group_assignments")
    .select("session_id,slide_id,user_id,group_number,assigned_at")
    .eq("session_id", sessionId).eq("slide_id", slideId).eq("user_id", userData.user.id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapGroupAssignment(data as Record<string, unknown>) : null;
}

export function subscribeToSession(
  sessionId: string,
  onSession: (session: ClassSession) => void,
  onResponse: (response: StudentResponse) => void,
): RealtimeChannel {
  const client = requireSupabase();
  const responseHandler = (payload: { new: Record<string, unknown> }) => {
    if (payload.new?.id) onResponse(mapResponse(payload.new));
  };
  return client.channel(`plexia-session-${sessionId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "class_sessions", filter: `id=eq.${sessionId}` },
      (payload: { new: Record<string, unknown> }) => onSession(mapSession(payload.new)))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "student_responses", filter: `session_id=eq.${sessionId}` },
      responseHandler)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "student_responses", filter: `session_id=eq.${sessionId}` },
      responseHandler)
    .subscribe();
}

export function subscribeToPresentation(presentationId: string, onPresentation: (presentation: Presentation) => void): RealtimeChannel {
  const client = requireSupabase();
  return client.channel(`plexia-presentation-${presentationId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "presentations", filter: `id=eq.${presentationId}` },
      (payload: { new: Record<string, unknown> }) => {
        if (payload.new?.data && typeof payload.new.data === "object") onPresentation(payload.new.data as Presentation);
      })
    .subscribe();
}

export async function updateTeacherReview(responseId: string, score: number, feedback: string, aiEvaluation?: Record<string, unknown>): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.from("student_responses").update({ score, feedback, reviewed: true, ...(aiEvaluation ? { ai_evaluation: aiEvaluation } : {}) }).eq("id", responseId);
  if (error) throw error;
}

export async function groqProxy<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke("groq-proxy", { body: { action, ...payload } });
  if (error) {
    const body = await error.context?.json?.().catch(() => null);
    throw new Error(body?.error ?? error.message ?? "Der KI-Dienst ist derzeit nicht erreichbar.");
  }
  return data as T;
}

export async function saveGroqKey(key: string): Promise<void> {
  if (!key.trim().startsWith("gsk_")) throw new Error("Der Groq API Key sollte mit gsk_ beginnen.");
  await groqProxy("save_key", { key: key.trim() });
}

export async function getGroqKeyStatus(): Promise<{ configured: boolean; updatedAt?: string }> {
  return groqProxy("key_status", {});
}

export async function requestAiEvaluation(payload: {
  answer: string;
  question: string;
  criteria: string[];
  maxPoints: number;
}): Promise<{ evaluation: import("./model").GroqEvaluation }> {
  return groqProxy("evaluate", payload as unknown as Record<string, unknown>);
}
