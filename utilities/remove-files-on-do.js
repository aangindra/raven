const aws = require("aws-sdk");
const dayjs = require("dayjs");
const mongodbConnection = require('../mongodb_connection');

const s3 = new aws.S3({
  endpoint: new aws.Endpoint("sgp1.digitaloceanspaces.com")
});

const start = async () => {
  const collection = await mongodbConnection('WA');
  const sevenDayAgo = dayjs().subtract(7, "day").toISOString();
  const totalMessages = await collection('Messages').find({
    $or:[
      {
        sentAt: {
          $exists: true
        }
      },
      {
        errorAt: {
          $exists: true
        }
      },
      {
        errorMessage: {
          $exists: true
        }
      }
    ],
    _createdAt: {
      $lte: sevenDayAgo
    }
  }).toArray();
  let countImage = 0;
  let countFile = 0;
  for(const message of totalMessages){
    if(validUrl(message.image)){
      if(message.image.match(/WHATSAPP_IMAGES/g)){
        console.log("URL =>", message.image);
        await removeObjectFromSpaces(message.image);
        countImage++;
      }
    }else if(validUrl(message.file)){
      if(message.file.match(/WHATSAPP_DOCUMENTS/g)){
        console.log("URL =>", message.file);
        await removeObjectFromSpaces(message.file);
        countFile++;
      }
    }else{
      console.log("message does not have file or image...")
    }
  }
  console.log(`Successfully deleted ${countImage} images and ${countFile} files!`);
}

const validUrl = url => {
  if (!url) return false;
  if(url.match(/(https?:\/\/\S+)/g)){
    return true
  }
  return false
}

const removeObjectFromSpaces = url => {
  if (!url) return;
  const Key = url.replace(
    "https://schooltalk.sgp1.digitaloceanspaces.com/",
    ""
  );
  s3.deleteObject(
    {
      Bucket: "schooltalk",
      Key
    },
    err => {
      // if(!err){
      //   console.log("file successfully deleted!");
      // }else{
      //   console.log("deleteObject", err);
      // }
    }
  );
};

start();