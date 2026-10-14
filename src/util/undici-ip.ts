import diagnosticsChannel from "node:diagnostics_channel";
import { Dispatcher } from "undici";

type RemoteAddressCallback = (remoteAddress?: string) => void;

type RequestCreateMessage = {
  request: object;
};

type SendHeadersMessage = {
  request: object;
  socket: {
    remoteAddress?: string;
  };
};

const requestTrackers = new WeakMap<object, RemoteAddressCallback>();
const activeTrackers: RemoteAddressCallback[] = [];

let initialized = false;

function initDiagnostics() {
  if (initialized) {
    return;
  }

  initialized = true;

  diagnosticsChannel.channel("undici:request:create").subscribe((message) => {
    const { request } = message as RequestCreateMessage;
    const tracker = activeTrackers[activeTrackers.length - 1];
    if (tracker && request) {
      requestTrackers.set(request, tracker);
    }
  });

  diagnosticsChannel
    .channel("undici:client:sendHeaders")
    .subscribe((message) => {
      const { request, socket } = message as SendHeadersMessage;
      const tracker = requestTrackers.get(request);
      if (tracker) {
        tracker(socket.remoteAddress);
      }
    });
}

/**
 * Associate each request dispatched through this wrapper with the exact
 * socket on which Undici sends it. The request:create event is synchronous
 * with dispatch; sendHeaders may occur later and supplies the actual socket.
 */
export function trackRemoteIPAddress(
  dispatcher: Dispatcher,
  onRemoteAddress: RemoteAddressCallback,
) {
  initDiagnostics();

  return dispatcher.compose((dispatch) => (opts, handler) => {
    activeTrackers.push(onRemoteAddress);
    try {
      return dispatch(opts, handler);
    } finally {
      activeTrackers.pop();
    }
  });
}
