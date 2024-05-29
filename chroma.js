import { ChromaClient } from "chromadb";

const client = new ChromaClient();

const collection = await client.getOrCreateCollection({
  name: "my_collection"
});


// add document
await collection.upsert({
  documents: ["This is a document about pineapple",
    "This is a document about oranges"],
  ids: ["id1", "id2"]
});

// [[1.0, 0.0, 0.1], [0.0, 1.0, 0.1], [0.1, 0.1, 1.0]
const result = await collection.query({
  queryTexts: ["This is a query document about hawaii"],
  nResults: 1
});

console.log(result);