const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export class TurnManager {
  constructor({ maxEvents = 800, maxCompleted = 100, now = () => Date.now() } = {}) {
    this.maxEvents = maxEvents;
    this.maxCompleted = maxCompleted;
    this.now = now;
    this.turns = new Map();
    this.completed = [];
  }

  create({ id, threadId, provider = "", model = "", toolPolicy = "read-only" }) {
    if (!id || !threadId) throw new Error("Turn id and threadId are required.");
    if (this.turns.has(id)) throw new Error(`Turn already exists: ${id}`);
    const controller = new AbortController();
    let resolveSettled;
    const settled = new Promise((resolve) => { resolveSettled = resolve; });
    const turn = {
      id,
      threadId,
      provider,
      model,
      toolPolicy,
      status: "running",
      createdAt: new Date(this.now()).toISOString(),
      completedAt: null,
      controller,
      events: [],
      listeners: new Set(),
      nextSeq: 1,
      result: null,
      error: null,
      settled,
      resolveSettled
    };
    this.turns.set(id, turn);
    return this.publicTurn(turn);
  }

  emit(id, type, data = {}) {
    const turn = this.require(id);
    const event = {
      seq: turn.nextSeq++,
      type: String(type || "turn.event"),
      at: new Date(this.now()).toISOString(),
      ...data
    };
    turn.events.push(event);
    if (turn.events.length > this.maxEvents) turn.events.splice(0, turn.events.length - this.maxEvents);
    for (const listener of turn.listeners) listener(event);
    return event;
  }

  subscribe(id, listener, { after = 0 } = {}) {
    const turn = this.require(id);
    for (const event of turn.events) {
      if (event.seq > Number(after || 0)) listener(event);
    }
    if (!TERMINAL_STATUSES.has(turn.status)) turn.listeners.add(listener);
    return () => turn.listeners.delete(listener);
  }

  requestCancel(id, reason = "Cancelled by user.") {
    const turn = this.require(id);
    if (TERMINAL_STATUSES.has(turn.status)) return this.publicTurn(turn);
    if (turn.status !== "cancelling") {
      turn.status = "cancelling";
      this.emit(id, "turn.cancel_requested", { reason });
      turn.controller.abort(abortError(reason));
    }
    return this.publicTurn(turn);
  }

  complete(id, result, { eventResult = result } = {}) {
    return this.settle(id, "completed", { result, eventResult });
  }

  fail(id, error) {
    return this.settle(id, "failed", { error });
  }

  cancelled(id, reason = "Turn cancelled.") {
    return this.settle(id, "cancelled", { error: abortError(reason) });
  }

  wait(id) {
    return this.require(id).settled;
  }

  signal(id) {
    return this.require(id).controller.signal;
  }

  get(id) {
    const turn = this.turns.get(id);
    return turn ? this.publicTurn(turn) : null;
  }

  getEvents(id, { after = 0 } = {}) {
    return this.require(id).events.filter((event) => event.seq > Number(after || 0)).map((event) => ({ ...event }));
  }

  getActiveByThread(threadId) {
    for (const turn of this.turns.values()) {
      if (turn.threadId === threadId && !TERMINAL_STATUSES.has(turn.status)) return this.publicTurn(turn);
    }
    return null;
  }

  listActive() {
    return [...this.turns.values()].filter((turn) => !TERMINAL_STATUSES.has(turn.status)).map((turn) => this.publicTurn(turn));
  }

  close(reason = "Studio is shutting down.") {
    for (const turn of this.turns.values()) {
      if (!TERMINAL_STATUSES.has(turn.status)) this.requestCancel(turn.id, reason);
    }
  }

  settle(id, status, { result = null, eventResult = result, error = null } = {}) {
    const turn = this.require(id);
    if (TERMINAL_STATUSES.has(turn.status)) return this.publicTurn(turn);
    turn.status = status;
    turn.result = result;
    turn.error = error instanceof Error ? error.message : error ? String(error) : null;
    turn.completedAt = new Date(this.now()).toISOString();
    this.emit(id, `turn.${status}`, {
      ...(status === "completed" ? { result: eventResult } : {}),
      ...(turn.error ? { error: turn.error } : {})
    });
    const settled = {
      ...this.publicTurn(turn),
      result: turn.result,
      error: turn.error
    };
    turn.listeners.clear();
    turn.resolveSettled(settled);
    this.completed.push(id);
    this.prune();
    return this.publicTurn(turn);
  }

  publicTurn(turn) {
    return {
      id: turn.id,
      threadId: turn.threadId,
      provider: turn.provider,
      model: turn.model,
      toolPolicy: turn.toolPolicy,
      status: turn.status,
      createdAt: turn.createdAt,
      completedAt: turn.completedAt,
      lastSeq: turn.nextSeq - 1,
      error: turn.error
    };
  }

  require(id) {
    const turn = this.turns.get(id);
    if (!turn) throw new Error(`Turn not found: ${id}`);
    return turn;
  }

  prune() {
    while (this.completed.length > this.maxCompleted) {
      const id = this.completed.shift();
      this.turns.delete(id);
    }
  }
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}

function abortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
