const dayjs = require("dayjs");

const calculateMessage = async (collection) => {
  const startDate = dayjs().startOf("day").toISOString();
  const endDate = dayjs().endOf("day").toISOString();

  const countAllMessages = await collection("Messages")
    .find({
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
    console.log({
      countAllMessages,
      countAllSentMessages,
      countAllErrorMessages,
      countAllPendingMessages,
    })
  return {
    countAllMessages,
    countAllSentMessages,
    countAllErrorMessages,
    countAllPendingMessages,
  };
};

exports.calculateMessage = calculateMessage;
