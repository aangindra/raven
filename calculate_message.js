const dayjs = require("dayjs");

const calculateMessage = async (collection) => {
  const startDate = dayjs().startOf("day").toISOString();
  const endDate = dayjs().endOf("day").toISOString();

  const countAllMessages = await collection("Messages")
    .find({
      type: {
        $ne: "AUTOREPLY"
      },
      _deletedAt: {
        $exists: false,
      },
      _createdAt: {
        $gte: startDate,
        $lte: endDate,
      },
    })
    .count();
  const countAllErrorMessages = await collection("Messages")
    .find({
      type: {
        $ne: "AUTOREPLY"
      },
      $or: [
        {
          errorAt: {
            $exists: true,
          },
        },
        {
          errorMessage: {
            $exists: true,
          },
        },
      ],
      _createdAt: {
        $gte: startDate,
        $lte: endDate,
      },
      _deletedAt: {
        $exists: false,
      },
    })
    .count();
  const countAllSentMessages = await collection("Messages")
    .find({
      type: {
        $ne: "AUTOREPLY"
      },
      sentAt: {
        $exists: true,
      },
      _createdAt: {
        $gte: startDate,
        $lte: endDate,
      },
      _deletedAt: {
        $exists: false,
      },
    })
    .count();
  const countAllPendingMessages = await collection("Messages")
    .find({
      type: {
        $ne: "AUTOREPLY"
      },
      sentAt: {
        $exists: false,
      },
      errorAt: {
        $exists: false,
      },
      _createdAt: {
        $gte: startDate,
        $lte: endDate,
      },
      _deletedAt: {
        $exists: false,
      },
    })
    .count();
    
  return {
    countAllMessages,
    countAllSentMessages,
    countAllErrorMessages,
    countAllPendingMessages,
  };
};

exports.calculateMessage = calculateMessage;
