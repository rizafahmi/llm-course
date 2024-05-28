import http from 'http';
import fs from 'fs';

const LLAMA_API_URL = process.env.LLAMA_API_URL || 'http://127.0.0.1:11434/api/generate';

const SYSTEM_MESSAGE = `You run in a process of Question, Thought, Action, Observation.

Use Thought to describe your thoughts about the question you have been asked.
Observation will be the result of running those actions.

If you can not answer the question from your memory, use Action to run one of these actions available to you:

- exchange: from to
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

Question: What is the exchange rate from USD to EUR?
Thought: This is about currency exchange rates, I need to check the current rate.
Action: exchange: USD EUR
Observation: 0.8276 EUR for 1 USD.
Answer: The current exchange rate is 0.8276 EUR for 1 USD.

Let's go!

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

async function reason(inquiry) {
  const prompt = SYSTEM_MESSAGE + "\n\n" + inquiry;
  const response = await llama(prompt);

  console.log(`--------------\n${response}\n--------------`)
  
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
    const answer = await reason(`Question: ${question}`);
    console.log({ question, answer });
    res.writeHead(200).end(answer);
  } else {
    res.writeHead(404).end("Not Found");
  }
}

http.createServer(handler).listen(3000);