import { Router } from "express";
import multer from "multer";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";

export default function createUploadRoutes(db, auth) {
    const router = Router();

    const upload = multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize: 5 * 1024 * 1024,
        },
        fileFilter: (req, file, cb) => {
            const allowed = [
                "image/jpeg",
                "image/png",
                "image/webp",
            ];

            if (!allowed.includes(file.mimetype)) {
                return cb(
                    new Error("Only JPG, PNG and WebP images are allowed.")
                );
            }

            cb(null, true);
        },
    });

    const requireVendor = async (req, res, next) => {
        try {
            const session = await auth.api.getSession({
                headers: fromNodeHeaders(req.headers),
            });

            if (!session?.user?.id) {
                return res.status(401).json({
                    message: "Please sign in first.",
                });
            }

            if (!ObjectId.isValid(session.user.id)) {
                return res.status(401).json({
                    message: "Invalid user session.",
                });
            }

            const user = await db.collection("user").findOne({
                _id: new ObjectId(session.user.id),
            });

            if (!user || user.role !== "vendor" || user.blocked === true) {
                return res.status(403).json({
                    message: "Only active vendors can upload images.",
                });
            }

            next();
        } catch {
            return res.status(500).json({
                message: "Failed to verify account.",
            });
        }
    };

    router.post(
        "/image",
        requireVendor,
        (req, res, next) => {
            upload.single("image")(req, res, (error) => {
                if (error) {
                    return res.status(400).json({
                        message: error.message,
                    });
                }

                next();
            });
        },
        async (req, res) => {
            try {
                if (!req.file) {
                    return res.status(400).json({
                        message: "Please select an image.",
                    });
                }

                if (!process.env.IMGBB_API_KEY) {
                    return res.status(500).json({
                        message: "ImgBB is not configured.",
                    });
                }

                const formData = new FormData();

                formData.append(
                    "image",
                    new Blob([req.file.buffer], {
                        type: req.file.mimetype,
                    }),
                    req.file.originalname
                );

                const response = await fetch(
                    `https://api.imgbb.com/1/upload?key=${encodeURIComponent(
                        process.env.IMGBB_API_KEY
                    )}`,
                    {
                        method: "POST",
                        body: formData,
                    }
                );

                const result = await response.json();

                if (!response.ok || !result.success || !result.data?.url) {
                    return res.status(502).json({
                        message: "ImgBB image upload failed.",
                    });
                }

                return res.status(200).json({
                    url: result.data.url,
                });
            } catch (error) {
                return res.status(500).json({
                    message: "Failed to upload image.",
                });
            }
        }
    );

    return router;
}
