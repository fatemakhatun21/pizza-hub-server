
import { ObjectId } from "mongodb";

export async function withVendorItemLimit({
    client,
    db,
    vendorId,
    activating = false,
    mutate,
}) {
    const session = client.startSession();

    try {
        return await session.withTransaction(async () => {
            const vendor = await db.collection("user").findOneAndUpdate(
                {
                    _id: new ObjectId(vendorId),
                    role: "vendor",
                    blocked: { $ne: true },
                },
                {
                    $inc: { activePizzaRevision: 1 },
                },
                {
                    session,
                    returnDocument: "after",
                }
            );

            if (!vendor) {
                return {
                    status: 403,
                    message: "Vendor account is unavailable",
                };
            }

            if (activating && vendor.plan !== "premium") {
                const activeCount = await db
                    .collection("menuItems")
                    .countDocuments(
                        {
                            vendorId,
                            status: "approved",
                            isActive: true,
                        },
                        { session }
                    );

                if (activeCount >= 3) {
                    return {
                        status: 403,
                        message:
                            "Free vendors can have at most 3 active pizzas",
                    };
                }
            }

            return mutate({ session, vendor });
        });
    } finally {
        await session.endSession();
    }
}
