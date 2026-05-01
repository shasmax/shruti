export interface Utterance {
  speaker: string;
  ts: [number, number];
  text: string;
}

export interface Participant {
  name: string;
  role?: string;
}

export interface Transcript {
  meeting_id: string;
  started_at?: string;
  duration_s?: number;
  participants?: Participant[];
  utterances: Utterance[];
}

export type SpecKind =
  | "feature_request"
  | "decision"
  | "action_item"
  | "schema_change"
  | "question";

export interface SpecItem {
  kind: SpecKind;
  speaker: string;
  ts: [number, number];
  quote: string;
  intent?: string;
  params?: Record<string, unknown>;
  owner?: string;
  due?: string;
  confidence: number;
}

export interface Spec {
  meeting_id: string;
  schema_version: "0.1";
  started_at?: string;
  duration_s?: number;
  participants?: Participant[];
  items: SpecItem[];
}
