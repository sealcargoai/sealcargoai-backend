const STUB = new URL("./alibaba-stub.mjs", import.meta.url).href;
export async function resolve(spec, ctx, next) {
  if (/services\/alibaba\.js$/.test(spec)) return { url: STUB, shortCircuit: true };
  return next(spec, ctx);
}
