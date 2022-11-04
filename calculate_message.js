const dayjs = require("dayjs");

const calculateMessage = async (collection) => {
  let startDate = dayjs().subtract(1, "day").format("YYYY-MM-DD");
  startDate = `${startDate}T17:00:00.000Z`;
  let endDate = dayjs().format("YYYY-MM-DD");
  endDate = `${endDate}T16:59:59.999Z`;

  const countAllMessages = await collection("Messages")
    .find({
      type: {
        $ne: "AUTOREPLY",
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
        $ne: "AUTOREPLY",
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
        $ne: "AUTOREPLY",
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
        $ne: "AUTOREPLY",
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
  console.log({
    countAllMessages,
    countAllSentMessages,
    countAllErrorMessages,
    countAllPendingMessages,
  });
  return {
    countAllMessages,
    countAllSentMessages,
    countAllErrorMessages,
    countAllPendingMessages,
  };
};

exports.calculateMessage = calculateMessage;
