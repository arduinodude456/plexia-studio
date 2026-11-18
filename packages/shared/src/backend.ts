import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { ClassSession, Presentation, SessionBundle, StudentResponse } from "./model";

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

export async function signInTeacher(email: string, password: string) {
  const client = requireSupabase();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
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
  const { data, error } = await supabase.auth.getUser();
  if (error && error.name !== "AuthSessionMissingError") throw error;
  return data.user;
}

export async function listPresentations(): Promise<Presentation[]> {
  const client = requireSupabase();
  const { data, error } = await client.from("presentations").select("data").order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row: { data: Presentation }) => row.data);
}

export async function savePresentation(presentation: Presentation): Promise<void> {
  const client = requireSupabase();
  const { data: userResult, error: userError } = await client.auth.getUser();
  if (userError) throw userError;
  if (!userResult.user) throw new Error("Bitte melde dich an, um die Präsentation in der Cloud zu speichern.");
  const next = { ...presentation, updatedAt: new Date().toISOString() };
  const { error } = await client.from("presentations").upsert({
    id: next.id,
    owner_id: userResult.user.id,
    title: next.title,
    description: next.description,
    data: next,
    updated_at: next.updatedAt,
  });
  if (error) throw error;
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

export async function createClassSession(presentation: Presentation): Promise<ClassSession> {
  const client = requireSupabase();
  await savePresentation(presentation);
  const { data, error } = await client.from("class_sessions").insert({
    presentation_id: presentation.id,
    status: "live",
    current_slide_index: 0,
    activity_status: "idle",
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
  const { data, error } = await client.from("student_responses").insert({
    session_id: input.sessionId,
    slide_id: input.slideId,
    participant_id: userResult.user.id,
    nickname: input.nickname.trim().slice(0, 24),
    answer_text: input.answerText ?? "",
    answer_json: input.answerJson ?? {},
    media_path: input.mediaPath ?? null,
  }).select("id,session_id,slide_id,participant_id,nickname,answer_text,answer_json,media_path,created_at,score,feedback,reviewed").single();
  if (error) throw error;
  return mapResponse(data as Record<string, unknown>);
}

export async function uploadStudentPhoto(sessionId: string, file: File): Promise<string> {
  const client = requireSupabase();
  if (!file.type.startsWith("image/")) throw new Error("Bitte wähle eine Bilddatei aus.");
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

export function subscribeToSession(
  sessionId: string,
  onSession: (session: ClassSession) => void,
  onResponse: (response: StudentResponse) => void,
): RealtimeChannel {
  const client = requireSupabase();
  return client.channel(`plexia-session-${sessionId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "class_sessions", filter: `id=eq.${sessionId}` },
      (payload: { new: Record<string, unknown> }) => onSession(mapSession(payload.new)))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "student_responses", filter: `session_id=eq.${sessionId}` },
      (payload: { new: Record<string, unknown> }) => onResponse(mapResponse(payload.new)))
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
