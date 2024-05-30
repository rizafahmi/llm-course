import http from 'http';
import fs from 'fs';
import { readPdfPages } from "pdf-text-reader";

const FEATURE_MODEL = "Xenova/all-MiniLM-L6-v2";
const LLAMA_API_URL = process.env.LLAMA_API_URL || 'http://127.0.0.1:11434/api/generate';

const HISTORY_MESSAGE = "Before formulating a thought, consider the following conversation history.";

const SYSTEM_MESSAGE = `You run in a process of Question, Thought, Action, Observation.

Use Thought to describe your thoughts about the question you have been asked.
Observation will be the result of running those actions.

If you can not answer the question from your memory, use Action to run one of these actions available to you:
- lookup: terms

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

`;

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

async function reason(history, inquiry) {

  const prompt = `${SYSTEM_MESSAGE}\n\n${context(history)}\n\nNow let's answer some question!\n\n${inquiry}`;
  const response = await llama(prompt);

  let conclusion = "";

  const action = await act(response);
  if (action === null) {
    return answer(response);
  } else {
    conclusion = await llama(finalPrompt(inquiry, action.result));
  }

  return conclusion;
}

async function act(text) {
  const MARKER = "Action:";
  const pos = text.lastIndexOf(MARKER);
  if (pos < 0) return null;

  const subtext = text.substr(pos) + "\n";
  const matches = /Action:\s*(.*?)\n/.exec(subtext);
  const action = matches[1];
  if (!action) return null;

  const SEPARATOR = ":";
  const sep = action.indexOf(SEPARATOR);
  if (sep < 0) return null;

  const name = action.substring(0, sep);
  const args = action.substring(sep + 1).trim().split(" ");

  if (name === "lookup") return null;
  if (name === "exchange") {
    const result = await exchange(args[0].trim(), args[1].trim());
    console.log("ACT Exchange", { args, result });
    return { action, name, args, result };
  }
  console.error("Not recognized action", { name, args });
  return null;
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
async function answer(text) {
  const MARKER = "Answer:";
  const pos = text.lastIndexOf(MARKER);
  if (pos < 0) return "?";
  const answer = text.substr(pos + MARKER.length).trim();
  return answer;
}

let state = {
  history: [],
  source: "No source",
  reference: "No reference"
};

// !history
function command(key, response) {
  const value = state[key.substring(1)];
  if (value && typeof value === "string") {
    response.writeHead(200).end(value);
    return true;
  }
  return false;
}

async function ingest(url) {
  // sequence(5) => [0, 1, 2, 3, 4]
  const sequence = (N) => Array.from({ length: N }, (_, i) => i);
  
  // create object {} to map page number with entries(content)
  const paginate = (entries, pagination) => entries.map(entry => {
    const { offset } = entry;
    const page = pagination.findIndex(i => i > offset);
    console.log({entry})
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
    console.log(" RESULT: ", result)
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

    // Command
    if (question === "!reset") {
      state.history.length = 0;
      response.writeHead(200).end("Reset the history...");
      return;
    }
    if (command(question, res)) {
      return;
    }
    const answer = await reason(state.history, `Question: ${question}`);
    res.writeHead(200).end(answer);
    state.history.push({question, answer});

    while (state.history.length > 3) {
      state.history.shift();
    }
  } else {
    res.writeHead(404).end("Not Found");
  }
}

http.createServer(handler).listen(3000);