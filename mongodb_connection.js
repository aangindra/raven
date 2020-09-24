require('dotenv').config();
const { MongoClient } = require("mongodb");

let userAndPass = "";
if (
  process.env.MONGOD_USERNAME &&
  process.env.MONGOD_PASSWORD &&
  process.env.MONGOD_AUTH_SOURCE
) {
  userAndPass = `${process.env.MONGOD_USERNAME}:${
    process.env.MONGOD_PASSWORD
  }@`;
}

if (
  !process.env.MONGOD_HOST ||
  !process.env.MONGOD_PORT ||
  !process.env.MONGOD_DB
) {
  console.log("Incomplete environment variables. Process exitting...");
  process.exit(1);
}

const MONGO_URL = `mongodb://${userAndPass}${process.env.MONGOD_HOST}:${
  process.env.MONGOD_PORT
}/${process.env.MONGOD_DB}${
  process.env.MONGOD_AUTH_SOURCE
    ? "?authSource=" + process.env.MONGOD_AUTH_SOURCE
    : ""
}`;

module.exports = async () => {
  try {
    const client = await MongoClient.connect(
      MONGO_URL,
      {
        useNewUrlParser: true
      }
    );
    const db = await client.db(process.env.MONGOD_DB);

    return collectionName => db.collection(collectionName);
  } catch (e) {
    console.log(process.env.MONGOD_AUTH_SOURCE)
    console.log(e);
  }
};
