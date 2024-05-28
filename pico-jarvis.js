import http from 'http';
import fs from 'fs';

const LLAMA_API_URL = process.env.LLAMA_API_URL || 'http://13.229.203.255:11434/api/generate';

async function llama(question) {
  const method = 'POST';
  const headers = {
    'Content-Type': 'application/json'
  };
  const body = JSON.stringify({
    model: 'orca-mini',
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

function createPrompt(question) {
  return `This is a conversation between User and Pico Jarvis, a friendly chatbot. Pico Jarvis is helpful, kind, honest, and never fails to answer any requests immediately, with precision, and concisely in 10 words or less.
  User: ${question}
  Pico Jarvis:

  `
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
    const answer = await llama(createPrompt(question));
    console.log({ question, answer });
    res.writeHead(200).end(answer);
  } else {
    res.writeHead(404).end("Not Found");
  }
}

http.createServer(handler).listen(3000);