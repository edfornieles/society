export type RealtimeClientEvent = Record<string, any>;
export type RealtimeServerEvent = Record<string, any>;

export function mkSessionUpdate(payload: any): RealtimeClientEvent {
  return { type: "session.update", session: payload };
}

export function mkResponseCreate(payload?: any): RealtimeClientEvent {
  return { type: "response.create", response: payload ?? {} };
}

export function mkConversationItemCreate(payload: any): RealtimeClientEvent {
  return { type: "conversation.item.create", item: payload };
}

export function mkResponseCancel(): RealtimeClientEvent {
  return { type: "response.cancel" };
}

export function mkFunctionCallOutput(call_id: string, outputObj: any): RealtimeClientEvent {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id,
      output: JSON.stringify(outputObj ?? {}),
    },
  };
}
