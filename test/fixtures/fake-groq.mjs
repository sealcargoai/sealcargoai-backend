// TEST FIXTURE: with FAKE_GROQ_KEYWORD set, the keyword "translation" (Groq) answers that text, as a
// translation that changed the request would ("220 V" → "industrial compressor 380v"). Nothing leaves.
import axios from "axios";
if (process.env.FAKE_GROQ_KEYWORD) {
  const real = axios.post.bind(axios);
  axios.post = async (url, body, ...rest) => {
    if (!String(url).includes("api.groq.com")) return real(url, body, ...rest);
    // the shorter-keyword request (retry) gets its own answer, so the retry path is exercised too
    const short = /Shorten/.test(body?.messages?.[0]?.content || "");
    const content = short ? process.env.FAKE_GROQ_SHORT || "compressor 380v" : process.env.FAKE_GROQ_KEYWORD;
    return { data: { choices: [{ message: { content }, finish_reason: "stop" }] } };
  };
}
