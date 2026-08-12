import { browser } from 'wxt/browser';
import type {
  MessageKind,
  MessageMap,
  RequestEnvelope,
  ResponseEnvelope,
} from './messages';

/**
 * Typed wrappers over `runtime.sendMessage`.
 *
 * Errors are carried in the envelope rather than thrown across the boundary,
 * because a rejected promise in a service worker surfaces as an opaque
 * "message port closed" on the other side and hides the real cause.
 */

/** Errors the UI is expected to handle rather than log. */
export class MessagingError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

type Handler<K extends MessageKind> = (
  payload: MessageMap[K]['req'],
  sender: chrome.runtime.MessageSender,
) => Promise<MessageMap[K]['res']> | MessageMap[K]['res'];

export type HandlerMap = { [K in MessageKind]?: Handler<K> };

function unwrap<K extends MessageKind>(response: ResponseEnvelope<K> | undefined): MessageMap[K]['res'] {
  if (!response) throw new MessagingError('NoResponse', 'The background service worker did not respond.');
  if (!response.ok) throw new MessagingError(response.error.name, response.error.message);
  return response.data;
}

/** Call the service worker from a content script, the options page or the side panel. */
export async function sendToBackground<K extends MessageKind>(
  kind: K,
  ...[payload]: MessageMap[K]['req'] extends undefined ? [] : [MessageMap[K]['req']]
): Promise<MessageMap[K]['res']> {
  const envelope: RequestEnvelope<K> = { kind, payload: payload as MessageMap[K]['req'] };
  return unwrap<K>((await browser.runtime.sendMessage(envelope)) as ResponseEnvelope<K>);
}

/** Call a specific tab's content script (all frames). */
export async function sendToTab<K extends MessageKind>(
  tabId: number,
  kind: K,
  ...[payload]: MessageMap[K]['req'] extends undefined ? [] : [MessageMap[K]['req']]
): Promise<MessageMap[K]['res']> {
  const envelope: RequestEnvelope<K> = { kind, payload: payload as MessageMap[K]['req'] };
  return unwrap<K>((await browser.tabs.sendMessage(tabId, envelope)) as ResponseEnvelope<K>);
}

/**
 * Register handlers. Returns an unsubscribe function.
 *
 * The listener returns `true` synchronously so Chrome keeps the port open for
 * the async handler — the single most common source of silent message loss.
 */
export function registerHandlers(handlers: HandlerMap): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: ResponseEnvelope) => void,
  ): boolean | undefined => {
    if (!isRequestEnvelope(message)) return undefined;
    const handler = handlers[message.kind] as Handler<MessageKind> | undefined;
    if (!handler) return undefined;

    void (async () => {
      try {
        const data = await handler(message.payload, sender);
        sendResponse({ ok: true, data });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        sendResponse({ ok: false, error: { name: err.name, message: err.message } });
      }
    })();

    return true;
  };

  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}

function isRequestEnvelope(value: unknown): value is RequestEnvelope {
  return typeof value === 'object' && value !== null && typeof (value as RequestEnvelope).kind === 'string';
}
