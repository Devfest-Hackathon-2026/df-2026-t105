export function muscriptorNotes(events: { type: string; index?: number; start_event_index?: number; pitch?: number; start_time?: number; end_time?: number; instrument?: string }[]): { pitch: number; start: number; end: number; instrument: string }[];
export function muscriptorInstruments(target: string, prompts: { text: string }[]): string[];
