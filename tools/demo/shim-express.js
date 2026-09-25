// The slice of Express's Router this app uses, run in the browser.
function compile(path) {
  const keys = [];
  const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
  return { re, keys };
}
// Runs the handlers in order. Returns a promise when a handler is async, so the caller can wait.
function runChain(handlers, req, res, done) {
  let i = 0;
  let pending;
  const next = (err) => {
    if (err) return done(err);
    const h = handlers[i++];
    if (!h) return done();
    try {
      const out = h(req, res, next);
      if (out && typeof out.then === 'function') pending = out.catch(done);
    } catch (e) { done(e); }
    return undefined;
  };
  next();
  return pending;
}
class Router {
  constructor() { this.stack = []; }
  add(method, path, handlers) { this.stack.push({ method, ...compile(path), handlers }); }
  get(p, ...h) { this.add('GET', p, h); }
  post(p, ...h) { this.add('POST', p, h); }
  patch(p, ...h) { this.add('PATCH', p, h); }
  put(p, ...h) { this.add('PUT', p, h); }
  delete(p, ...h) { this.add('DELETE', p, h); }
  // Calls done() if nothing matched, done(err) on error; otherwise the route responded.
  handle(req, res, done) {
    for (const layer of this.stack) {
      if (layer.method !== req.method) continue;
      const m = req.path.match(layer.re);
      if (!m) continue;
      req.params = {};
      layer.keys.forEach((k, j) => { req.params[k] = decodeURIComponent(m[j + 1]); });
      return runChain(layer.handlers, req, res, done);
    }
    done();
    return undefined;
  }
}
module.exports = { Router: () => new Router() };
