import { Writable } from "node:stream";
import { renderToPipeableStream, renderToStaticMarkup } from "react-dom/server";

/** Wait for lazy modules in Node SSR; never runs browser effects or needs a server/dist. */
export function renderSettled(element) {
  return new Promise((resolve, reject) => {
    const destination = new Writable({ write(_chunk, _encoding, done) { done(); } });
    // React 19 can emit completed segments after the shell. Render again once the
    // shared lazy resources have settled to obtain the actual DOM placement.
    destination.on("finish", () => resolve(renderToStaticMarkup(element)));
    destination.on("error", reject);
    const stream = renderToPipeableStream(element, {
      onAllReady() { stream.pipe(destination); },
      onError: reject,
    });
  });
}
