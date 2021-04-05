const redis = require("redis");
const { promisify } = require("util");

exports.initRedis = async () => {
  try {
    let client = redis.createClient();
    client.on("error", err => {
      console.log("Error " + err);
    });
    client.on("connect", () => {
      console.log("Connected to redis server as redis client!");
      client.select(15);
    });
    client.expireAsync = promisify(client.expire).bind(client);
    client.setAsync = promisify(client.set).bind(client);
    client.getAsync = promisify(client.get).bind(client);
    client.hsetAsync = promisify(client.hset).bind(client);
    client.hgetAsync = promisify(client.hget).bind(client);

    let cache = redis.createClient();
    cache.on("error", err => {
      console.log("Error " + err);
    });
    cache.on("connect", () => {
      console.log("Connected to redis server as redis cache!");
    });
    cache.expireAsync = promisify(cache.expire).bind(cache);
    cache.setAsync = promisify(cache.set).bind(cache);
    cache.getAsync = promisify(cache.get).bind(cache);
    cache.hsetAsync = promisify(cache.hset).bind(cache);
    cache.hgetAsync = promisify(cache.hget).bind(cache);

    return { redis: client, cache };
  } catch (e) {
    console.log(e);
  }
};
