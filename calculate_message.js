const calculateMessage = async (collection) => {
  const countAllMessages = await collection("Messages")
    .find({
      _deletedAt: {
        $exists: false,
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
