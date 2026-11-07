import { Client } from "@elastic/elasticsearch";

export const elasticsearchClient = new Client({
  node: process.env.ELASTICSEARCH_URL || "http://127.0.0.1:9200",
  ...(process.env.ELASTICSEARCH_API_KEY
    ? { auth: { apiKey: process.env.ELASTICSEARCH_API_KEY } }
    : process.env.ELASTICSEARCH_USERNAME && process.env.ELASTICSEARCH_PASSWORD
      ? {
          auth: {
            username: process.env.ELASTICSEARCH_USERNAME,
            password: process.env.ELASTICSEARCH_PASSWORD,
          },
        }
      : {}),
  requestTimeout: 5000,
  maxRetries: 2,
});

export async function connectElasticsearch() {
  try {
    const result = await elasticsearchClient.info();

    console.log(
      "Elasticsearch connected:",
      result.version.number
    );
  } catch (error) {
    console.error("Elasticsearch connection failed:", error);
    throw error;
  }
}