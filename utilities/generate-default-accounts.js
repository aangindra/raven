const uuidV4 = require("uuid/v4");
const dayjs = require("dayjs");
const bcrypt = require("bcryptjs");
const mongodbConnection = require("../mongodb_connection");

const start = async () => {
  const collection = await mongodbConnection();

  const username = "aangindra"; 
  const password = "ubuntu";

  const hashedPassword = bcrypt.hashSync(password, 8);

  const foundUser = await collection("Accounts").findOne({
    username,
  });
  
  if (foundUser) {
    console.warn("User sudah ada!")
    process.exit();
  }
  
  const User = {
    _id: uuidV4(),
    username,
    password: hashedPassword,
    _createdAt: new Date().toISOString(),
    _updatedAt: new Date().toISOString(),
  };

  await collection("Accounts").insertOne(User);
  
  const token = "GgXAVnDq3oqx49gxSuhW5VH88qxiGcOap9bkhHauQ7jDVElDGfIG4Ybeg80aXpq";
  
  await collection("UserTokens").insertOne({
    _id: uuidV4(),
    accountId: User._id,
    _token: token,
    _createdAt: new Date().toISOString(),
    _updatedAt: new Date().toISOString(),
  });

  console.log("User successfully created!")

  process.exit();
};

start();
