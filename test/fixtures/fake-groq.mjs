// TEST FIXTURE: with FAKE_GROQ_KEYWORD set, the keyword "translation" (Groq) answers that text, as a
// translation that changed the request would ("220 V" → "industrial compressor 380v"). Nothing leaves.
import axios from "axios";
if (process.env.FAKE_GROQ_KEYWORD || process.env.FAKE_GROQ_VISION || process.env.FAKE_GROQ_VISION_STATUS) {
  const real = axios.post.bind(axios);
  axios.post = async (url, body, ...rest) => {
    if (!String(url).includes("api.groq.com")) return real(url, body, ...rest);
    // 02-11x: a request carrying an image is the photo analysis; FAKE_GROQ_LOG records what was sent
    const parts = (body?.messages || []).flatMap((m) => [].concat(m?.content || [])).filter((p) => typeof p === "object");
    const image = parts.find((p) => p?.type === "image_url");
    if (image) {
      if (process.env.FAKE_GROQ_LOG) (await import("node:fs")).appendFileSync(process.env.FAKE_GROQ_LOG, JSON.stringify({ model: body.model, roles: (body.messages || []).map((m) => m.role), text: parts.find((p) => p?.type === "text")?.text || "", imageBytes: String(image.image_url?.url || "").length, ...(process.env.FAKE_GROQ_LOG_IMAGE === "1" ? { image: image.image_url?.url } : {}), response_format: body.response_format }) + "\n");
      // FAKE_GROQ_JSON_400=1: like production on 2026-11-05 when JSON mode is refused (the retry has no response_format)
      if (process.env.FAKE_GROQ_JSON_400 === "1" && body.response_format) {
        const err = new Error("Request failed with status code 400");
        err.response = { status: 400, data: { error: { message: "fake: response_format not supported with images" } } };
        throw err;
      }
      if (process.env.FAKE_GROQ_VISION_STATUS) {
        const err = new Error(`Request failed with status code ${process.env.FAKE_GROQ_VISION_STATUS}`);
        err.response = { status: Number(process.env.FAKE_GROQ_VISION_STATUS), data: {} };
        throw err;
      }
      return { data: { choices: [{ message: { content: process.env.FAKE_GROQ_VISION || "{}" }, finish_reason: "stop" }] } };
    }
    // the shorter-keyword request (retry) gets its own answer, so the retry path is exercised too
    const short = /Shorten/.test(body?.messages?.[0]?.content || "");
    const content = short ? process.env.FAKE_GROQ_SHORT || "compressor 380v" : process.env.FAKE_GROQ_KEYWORD || "water pump";
    return { data: { choices: [{ message: { content }, finish_reason: "stop" }] } };
  };
}
