export interface DeferQuestionOption {
  label: string;
  description?: string;
}

export interface DeferQuestion {
  question: string;
  header?: string;
  options: DeferQuestionOption[];
  multiSelect: boolean;
}

export interface DeferredEventInfo {
  kind: 'deferred';
  sessionId: string;
  questions: DeferQuestion[];
  toolUseId?: string;
}

export interface CompletedEventInfo {
  kind: 'completed';
  sessionId?: string;
  stopReason?: string;
}

export type DeferStreamResult = DeferredEventInfo | CompletedEventInfo;

export interface OrderedQuestionToolUse {
  toolUseId: string;
  questions: DeferQuestion[];
}

interface RawResultEvent {
  type?: unknown;
  session_id?: string;
  stop_reason?: string;
  deferred_tool_use?: {
    id?: string;
    name?: string;
    input?: { questions?: unknown };
  };
}

export class StreamJsonDeferConsumer {
  private buffer = '';
  private lastResult: RawResultEvent | undefined;
  private readonly orderedQuestionToolUses: OrderedQuestionToolUse[] = [];
  private readonly seenQuestionToolUseIds = new Set<string>();

  consume(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    this.buffer += text;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trimEnd();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      this.consumeLine(line);
    }
  }

  flush(): void {
    if (this.buffer.trim().length > 0) {
      this.consumeLine(this.buffer.trim());
      this.buffer = '';
    }
  }

  private consumeLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const obj = parsed as Record<string, unknown>;
    if (obj.type === 'assistant') {
      this.consumeAssistantEvent(obj);
      return;
    }
    if (obj.type === 'result') {
      this.lastResult = obj;
    }
  }

  /** Returns a structured view of the final stream event, or `undefined` if no result event was seen. */
  getResult(): DeferStreamResult | undefined {
    const result = this.lastResult;
    if (!result) return undefined;
    if (result.stop_reason === 'tool_deferred') {
      const sessionId = typeof result.session_id === 'string' ? result.session_id : '';
      const rawQuestions = result.deferred_tool_use?.input?.questions;
      const questions = Array.isArray(rawQuestions)
        ? rawQuestions
            .map((q) => normalizeQuestion(q))
            .filter((q): q is DeferQuestion => q !== undefined)
        : [];
      const event: DeferredEventInfo = {
        kind: 'deferred',
        sessionId,
        questions,
      };
      if (typeof result.deferred_tool_use?.id === 'string') {
        event.toolUseId = result.deferred_tool_use.id;
      }
      return event;
    }
    const completed: CompletedEventInfo = { kind: 'completed' };
    if (typeof result.session_id === 'string') {
      completed.sessionId = result.session_id;
    }
    if (typeof result.stop_reason === 'string') {
      completed.stopReason = result.stop_reason;
    }
    return completed;
  }

  getQuestionToolUseOrder(): OrderedQuestionToolUse[] {
    return this.orderedQuestionToolUses.map((toolUse) => ({
      toolUseId: toolUse.toolUseId,
      questions: [...toolUse.questions],
    }));
  }

  private consumeAssistantEvent(event: Record<string, unknown>): void {
    const message = event.message;
    if (!message || typeof message !== 'object') return;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const toolUse = item as Record<string, unknown>;
      if (toolUse.type !== 'tool_use') continue;
      if (toolUse.name !== 'AskUserQuestion') continue;
      if (typeof toolUse.id !== 'string') continue;
      if (this.seenQuestionToolUseIds.has(toolUse.id)) continue;
      const input = toolUse.input;
      const rawQuestions =
        input && typeof input === 'object'
          ? (input as Record<string, unknown>).questions
          : undefined;
      const questions = Array.isArray(rawQuestions)
        ? rawQuestions
            .map((q) => normalizeQuestion(q))
            .filter((q): q is DeferQuestion => q !== undefined)
        : [];
      this.seenQuestionToolUseIds.add(toolUse.id);
      this.orderedQuestionToolUses.push({ toolUseId: toolUse.id, questions });
    }
  }
}

function normalizeQuestion(value: unknown): DeferQuestion | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.question !== 'string') return undefined;
  if (!Array.isArray(v.options)) return undefined;
  const options: DeferQuestionOption[] = [];
  for (const o of v.options) {
    if (!o || typeof o !== 'object') continue;
    const opt = o as Record<string, unknown>;
    if (typeof opt.label !== 'string') continue;
    const out: DeferQuestionOption = { label: opt.label };
    if (typeof opt.description === 'string') out.description = opt.description;
    options.push(out);
  }
  const result: DeferQuestion = {
    question: v.question,
    options,
    multiSelect: typeof v.multiSelect === 'boolean' ? v.multiSelect : false,
  };
  if (typeof v.header === 'string') result.header = v.header;
  return result;
}
