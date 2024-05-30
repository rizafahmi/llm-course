import http from 'http';
import fs from 'fs';
import { readPdfPages } from "pdf-text-reader";

const FEATURE_MODEL = "Xenova/all-MiniLM-L6-v2";
const LLAMA_API_URL = process.env.LLAMA_API_URL || 'http://127.0.0.1:11434/api/generate';

const HISTORY_MESSAGE = "Before formulating a thought, consider the following conversation history.";

const SYSTEM_MESSAGE = `You run in a process of Question, Thought, Action, Observation.

Think step by step. Always specify the full steps: Thought, Action, Observation, and Answer.

Use Thought to describe your thoughts about the question you have been asked.
For Action, choose exactly one of the following:

- lookup: terms

Observation will be the result of running those actions.
Finally at the end, state the Answer in the same language as the original Question.

Here are some sample sessions.

Question: What is capital of france?
Thought: This is about geography, I can recall the answer from my memory.
Action: lookup: capital of France.
Observation: Paris is the capital of France.
Answer: The capital of France is Paris.

Question: Who painted Mona Lisa?
Thought: This is about general knowledge, I can recall the answer from my memory.
Action: lookup: painter of Mona Lisa.
Observation: Mona Lisa was painted by Leonardo da Vinci .
Answer: Leonardo da Vinci painted Mona Lisa.

{{CONTEXT}}

Now it's your turn to answer the following!

Question: {{QUESTION}}`;

async function llama(question) {
  const method = 'POST';
  const headers = {
    'Content-Type': 'application/json'
  };
  const body = JSON.stringify({
    model: 'mistral-openorca',
    prompt: question,
    options: {
      num_predict: 200,
      temperature: 0,
      top_k: 20
    },
    stream: false
  });
  const opts = { method: method, headers: headers, body: body };
  const res = await fetch(LLAMA_API_URL, opts);
  const { response } = await res.json();

  return response.trim();
}

function context(history) {
  // make {question: question, answer: answer} => "Question: question\nAnswer: answer"
  const capitalize = (str) => str[0].toUpperCase() + str.slice(1);
  const flatten = (parts) => Object.keys(parts).filter(k => parts[k]).map(k => `${capitalize(k)}: ${parts[k]}`).join("\n");
  if (history.length > 0) {
    return `${HISTORY_MESSAGE}\n\n${history.map(flatten).join("\n")}`;
  } else {
    return '';
  }
}

function parse(text) {
  const parts = {};
  const MARKERS = ["Answer", "Observation", "Action", "Thought"];
  const ANCHOR = MARKERS.slice().pop();
  const start = text.lastIndexOf(ANCHOR + ":");
  if (start >= 0) {
    let str = text.substr(start);
    console.log("PARSE: ");
    for (let i = 0; i < MARKERS.length; ++i) {
      const marker = MARKERS[i];
      const pos = str.lastIndexOf(marker + ":");
      if (pos >= 0) {
        const substr = str.substr(pos + marker.length + 1).trim();
        const value = substr.split("\n").shift();
        str = str.slice(0, pos);
        const key = marker.toLowerCase();
        parts[key] = value;
        console.log(` ${parts[key]}: ${value}`)
      }
    }
  }
  return parts;
}

async function reason(document, history, inquiry) {

  const prompt = SYSTEM_MESSAGE
    .replace("{{CONTEXT}}", context(history))
    .replace("{{QUESTION}}", inquiry);
  const response = await llama(prompt);
  const steps = parse(prompt + "\n" + response);
  const { thought, action, observation } = steps;
  console.log('REASON:');
  console.log(' question:', inquiry);
  console.log(" thought:", thought);
  console.log(" action:", action);
  console.log(" observation:", observation);
  console.log(" intermediate answer:", steps.answer);

  const { result, source, reference } = await act(document, inquiry, action ? action: "lookup: " + inquiry);

  return { thought, action, observation, answer: result, source, reference };
}

const LOOKUP_PROMPT = `You are an expert in retrieving information.
You are given a {{KIND}}, and then you respond to a question.
Avoid stating your personal opinion. Avoid making other commentary.
Think step by step.

Here is the {{KIND}}:

{{PASSAGES}}

(End of {{KIND}})

Now it is time to use the above {{KIND}} exclusively to answer this.

Question: {{QUESTION}}
Thought: Let us the above reference document to find the answer.
Answer:`;

async function answer(kind, passages, question) {
  console.log("ANSWER:");
  console.log(" question:", question);
  console.log("-------- passages ---------");
  console.log(passages);
  console.log("--------------------------");
  const input = LOOKUP_PROMPT
    .replaceAll("{{KIND}}", kind)
    .replace("{{PASSAGES}}", passages)
    .replace("{{QUESTION", question)
  
  const output = await llama(input);
  const response = parse(input + output);
  console.log(" answer: ", response.answer);
  return response.answer;

}

async function lookup(document, question, hint) {

  async function encode(sentence) {
    const { pipeline } = await import("@xenova/transformers");
    const extractor = await pipeline("feature-extraction", FEATURE_MODEL, { quantize: true });

    const output = await extractor([sentence], { pooling: "mean", normalize: true });
    const vector = output[0].data;
    return vector;
  }

  async function search(q, document, top_k = 3) {
    const { cos_sim } = await import("@xenova/transformers");

    const vector = await encode(q);
    const matches = document.map((entry) => {
      const score = cos_sim(vector, entry.vector);
      return { score, ...entry };
    });

    const relevants = matches.sort((d1, d2) => d2.score - d1.score).slice(0, top_k);

    return relevants;

  }

  const ascending = (x, y) => x - y;
  const dedupe = (numbers) => [...new Set(numbers)];

  const MIN_SCORE = 0.4;

  if (document.length === 0) {
    throw new Error("Document is not indexed.")
  }

  console.log("LOOKUP:");
  console.log(" question: ", question);
  console.log(" hint: ", hint);

  const candidates = await search(question + " " + hint, document);
  const best = candidates.slice(0, 1).shift();
  console.log(" best score: ", best.score);
  if (best.score < MIN_SCORE) {
    const FROM_MEMORY = "From my memory.";
    return { result: hint, source: FROM_MEMORY, reference: FROM_MEMORY };
  }

  const indexes = dedupe(candidates.map(r => r.index)).sort(ascending);
  const relevants = document.filter(({ index }) => indexes.includes(index));
  const passages = relevants.map(({ sentence }) => sentence).join(" ");
  const result = await answer("reference document", passages, question);

  const refs = await search(result || hint, relevants);
  const top = refs.slice(0, 1).pop();
  let source = `Best source (page ${top.page + 1}, score ${Math.round(top.score * 100)}%)\n${top.sentence}`;
  console.log(" source: ", source);
  return { result, source, reference: passages };
}

async function act(document, question, action, observation) {
  const sep = action.indexOf(":");
  const name = action.substring(0, sep);
  const arg = action.substring(sep + 1).trim();

  if (name === "lookup") {
    const { result, source, reference } = await lookup(document, question, observation);

    return { result, source, reference };
  }

  // fallback to a manual lookup
  console.error("Not recognized action", name, arg);
  return await act(document, question, "lookup: " + question, observation);
}
function finalPrompt(inquiry, observation) {
  return `${inquiry}
  Observation: ${observation}
  Thought: Now I have the answer.
  Answer:`;
} 

async function exchange(from, to) {
  const url = `https://open.er-api.com/v6/latest/${from}`;
  console.log("Fetching ", url);
  const response = await fetch(url);
  const data = await response.json();
  const rate = data.rates[to];
  return `As per ${data.time_last_update_utc}, 1 ${from} equal to ${Math.ceil(rate)} ${from}.`;
}

let state = {
  history: [],
  source: "No source",
  reference: "No reference"
}

async function ingest(url) {
  // sequence(5) => [0, 1, 2, 3, 4]
  const sequence = (N) => Array.from({ length: N }, (_, i) => i);
  
  // create object {} to map page number with entries(content)
  const paginate = (entries, pagination) => entries.map(entry => {
    const { offset } = entry;
    const page = pagination.findIndex(i => i > offset);
    return { page, ...entry };
  });

  const isPunctuator = (ch) => (ch === ".") || (ch === "!") || (ch === "?");
  const isWhiteSpace = (ch) => (ch === " ") || (ch === "\n") || (ch === "\t");

  function split(text) {
    const chunks = [];
    let str = '';
    let offset = 0;
    for (let i = 0; i < text.length; ++i) {
      const ch1 = text[i];
      const ch2 = text[i + 1];
      if (isPunctuator(ch1) && isWhiteSpace(ch2)) {
        str += ch1;
        const text = str.trim();
        chunks.push({ offset, text });
        str = '';
        offset = i + 1;
      }
      str += ch1;
    }
    if (str.length > 0) {
        chunks.push({ offset, text: str.trim() });
    }
    return chunks;
  }

  async function vectorize(text) {
    const { pipeline } = await import("@xenova/transformers");
    const extractor = await pipeline("feature-extraction", FEATURE_MODEL, { quantize: true });

    const chunks = split(text);

    const result = [];
    for (let index = 0; index < chunks.length; index++) {
      const { offset } = chunks[index]; 
      const sentence = chunks.slice(index, index + 3).map(({ text }) => text).join(" ");
      const output = await extractor([sentence], { polling: "mean", normalize: true });
      const vector = output[0].data;
      result.push({ index, offset, sentence, vector });
    }
    return result;
  }

  console.log("INGEST: ");
  const input = await readPdfPages({ url });
  console.log(" url: ", url);
  const pages = input.map((page, number) => {
    return { number, content: page.lines.join(" ") }
  });

  console.log(" page count:", pages.length);
  const pagination = sequence(pages.length).map(k => pages.slice(0, k + 1).reduce((loc, page) => loc + page.content.length, 0)); 
  const text = pages.map(page => page.content).join(" ");
  const document = paginate(await vectorize(text), pagination);
  console.log(" Ingestion finish.");
  return document;

}

const document = await ingest("./document.pdf");

async function handler(req, res) {

  const { url } = req;

  if (url === '/health') {
    res.writeHead(200).end("OK");
  } else if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync('./index.html'));
  } else if (url.startsWith('/chat')) {
    const parsedUrl = new URL(`http://localhost${url}`);
    const { search } = parsedUrl;
    const question = decodeURIComponent(search.substring(1));
    const { thought, action, observation, answer, source, reference } = await reason(document, state.history, question);
    state.source = source;
    state.reference = reference;
    res.writeHead(200).end(answer);
    state.history.push({ question, thought, action, observation, answer });

    while (state.history.length > 3) {
      state.history.shift();
    }
  } else {
    res.writeHead(404).end("Not Found");
  }
}

http.createServer(handler).listen(3000);