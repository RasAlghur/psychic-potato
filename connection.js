import { createClient } from "redis";

export const redisConnection = async () => {
  const client = createClient({
    url: process.env.REDIS_HOST,
    password: process.env.REDIS_PASSWORD,
    port: process.env.REDIS_PORT,
  });

  client.on("error", (err) => {
    console.error("Redis Client Error", err);
  });

  try {
    await client.connect();
    console.log("Redis client connected successfully");
  } catch (err) {
    console.error("Error connecting to Redis", err);
    throw err;
  }

  return client;
};
