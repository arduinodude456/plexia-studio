export const slideTypes = [
  "standard",
  "video",
  "multiple_choice",
  "free_text",
  "worksheet",
  "photo_task",
  "mindmap",
  "brainstorm",
  "wordcloud",
  "poll",
  "group_work",
  "results",
] as const;

export type SlideType = (typeof slideTypes)[number];
export type ElementKind = "text" | "image" | "video" | "shape" | "table" | "chart";
export type SessionStatus = "live" | "paused" | "ended";
export type ActivityStatus = "idle" | "running" | "paused" | "ended";

export const slideTypeLabels: Record<SlideType, string> = {
  standard: "Standard",
  video: "Video",
  multiple_choice: "Multiple Choice",
  free_text: "Freitext",
  worksheet: "Arbeitsblatt",
  photo_task: "Foto-Aufgabe",
  mindmap: "Mindmap",
  brainstorm: "Brainstorming",
  wordcloud: "Wortwolke",
  poll: "Umfrage",
  group_work: "Gruppenarbeit",
  results: "Ergebnisse",
};

export interface SlideElement {
  id: string;
  kind: ElementKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  content: string;
  color?: string;
  background?: string;
  shape?: "rectangle" | "circle" | "line";
  rows?: string[][];
  points?: Array<{ label: string; value: number }>;
  alt?: string;
}

export interface SlideContent {
  body?: string;
  question?: string;
  prompt?: string;
  instructions?: string;
  options?: string[];
  allowMultiple?: boolean;
  criteria?: string[];
  maxPoints?: number;
  chartType?: "bar" | "pie";
  groupSize?: number;
  [key: string]: unknown;
}

export interface PlexiaSlide {
  id: string;
  type: SlideType;
  title: string;
  content: SlideContent;
  elements: SlideElement[];
  background: string;
  createdAt: string;
}

export interface Presentation {
  id: string;
  ownerId?: string;
  title: string;
  description: string;
  theme: "light" | "dark" | "ocean" | "violet";
  slides: PlexiaSlide[];
  version: 1;
  updatedAt: string;
}

export interface ClassSession {
  id: string;
  presentationId: string;
  joinCode: string;
  status: SessionStatus;
  currentSlideIndex: number;
  activityStatus: ActivityStatus;
  createdAt: string;
}

export interface SessionGroupAssignment {
  sessionId: string;
  slideId: string;
  userId: string;
  groupNumber: number;
  assignedAt: string;
}

export interface SessionBundle {
  session: ClassSession;
  presentation: Presentation;
}

export interface StudentResponse {
  id: string;
  sessionId: string;
  slideId: string;
  participantId: string;
  nickname: string;
  answerText: string;
  answerJson: Record<string, unknown>;
  mediaPath?: string | null;
  createdAt: string;
  score?: number | null;
  feedback?: string | null;
  reviewed?: boolean;
}

export interface GroqEvaluation {
  score: number;
  maxPoints: number;
  feedback: string;
  criteria: Array<{ name: string; points: number; rationale: string }>;
  needsTeacherReview: true;
}

export function createId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createSlide(type: SlideType = "standard", title?: string): PlexiaSlide {
  const now = new Date().toISOString();
  const content: SlideContent = {};
  if (type === "multiple_choice" || type === "poll") {
    content.question = type === "poll" ? "Was denkst du?" : "Welche Antwort ist richtig?";
    content.options = ["Antwort A", "Antwort B", "Antwort C"];
    content.allowMultiple = false;
  } else if (type === "free_text") {
    content.prompt = "Schreibe deine Antwort in eigenen Worten.";
    content.criteria = ["Fachliche Richtigkeit", "Begründung"];
    content.maxPoints = 4;
  } else if (type === "worksheet") {
    content.instructions = "Bearbeitet die Aufgaben Schritt für Schritt.";
  } else if (type === "photo_task") {
    content.instructions = "Fotografiere dein Ergebnis und lade es hier hoch.";
  } else if (type === "mindmap" || type === "brainstorm" || type === "wordcloud") {
    content.prompt = type === "mindmap" ? "Sammelt gemeinsam eure Gedanken." : "Teilt eure Ideen mit der Klasse.";
  } else if (type === "group_work") {
    content.instructions = "Arbeitet gemeinsam in eurer Gruppe.";
    content.groupSize = 4;
  }
  return {
    id: createId(),
    type,
    title: title ?? slideTypeLabels[type],
    content,
    elements: [],
    background: "#ffffff",
    createdAt: now,
  };
}

export function createStarterPresentation(): Presentation {
  const cover = createSlide("standard", "Vom Samenkorn zur Pflanze");
  cover.content.body = "Entdecke, was Pflanzen zum Wachsen brauchen.";
  cover.elements = [
    {
      id: createId(), kind: "text", x: 9, y: 24, width: 74, height: 18, rotation: 0, zIndex: 1,
      content: "Vom Samenkorn zur Pflanze", color: "#14264f", background: "transparent",
    },
    {
      id: createId(), kind: "text", x: 10, y: 47, width: 64, height: 14, rotation: 0, zIndex: 2,
      content: "Entdecke, was Pflanzen zum Wachsen brauchen.", color: "#516181", background: "transparent",
    },
  ];
  const quiz = createSlide("multiple_choice", "Was braucht eine Pflanze?");
  quiz.content.question = "Welche drei Dinge braucht eine Pflanze zum Wachsen?";
  quiz.content.options = ["Licht, Wasser und Luft", "Sand, Salz und Dunkelheit", "Nur Wasser"];
  const brainstorm = createSlide("brainstorm", "Ideen sammeln");
  brainstorm.content.prompt = "Welche Pflanzen kennst du aus deiner Umgebung?";
  return {
    id: createId(),
    title: "Vom Samenkorn zur Pflanze",
    description: "Eine interaktive Beispielstunde mit Quiz und gemeinsamer Ideensammlung.",
    theme: "light",
    slides: [cover, quiz, brainstorm],
    version: 1,
    updatedAt: new Date().toISOString(),
  };
}
