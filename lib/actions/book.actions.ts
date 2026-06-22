'use server';

import { auth } from "@clerk/nextjs/server";
import {CreateBook, TextSegment} from "@/types";
import {connectToDatabase} from "@/database/mongoose";
import {escapeRegex, generateSlug, serializeData} from "@/lib/utils";
import Book from "@/database/models/book.model";
import BookSegment from "@/database/models/book-segment.model";
import mongoose from "mongoose";

const getAuthenticatedUserId = async () => {
    const { userId } = await auth();

    if (!userId) {
        throw new Error('Unauthorized');
    }

    return userId;
};

const getOptionalAuthenticatedUserId = async () => {
    const { userId } = await auth();

    return userId;
};

export const getAllBooks = async (search?: string) => {
    try {
        await connectToDatabase();

        const userId = await getAuthenticatedUserId();
        const query: Record<string, unknown> = { clerkId: userId };

        if (search) {
            const escapedSearch = escapeRegex(search);
            const regex = new RegExp(escapedSearch, 'i');
            query.$or = [
                { title: { $regex: regex } },
                { author: { $regex: regex } },
            ];
        }

        const books = await Book.find(query).sort({ createdAt: -1 }).lean();

        return {
            success: true,
            data: serializeData(books)
        }
    } catch (e) {
        console.error('Error fetching books', e);
        return {
            success: false, error: e
        }
    }
}

const getAvailableSlug = async (baseSlug: string, userId: string) => {
    const ownBook = await Book.findOne({ clerkId: userId, slug: baseSlug }).lean();

    if (ownBook) {
        return { slug: baseSlug, existingBook: ownBook };
    }

    const globalBook = await Book.findOne({ slug: baseSlug }).lean();

    if (!globalBook) {
        return { slug: baseSlug, existingBook: null };
    }

    const userSlugPart = userId.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toLowerCase();
    const fallbackSlug = `${baseSlug}-${userSlugPart || Date.now()}`;

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = attempt === 0 ? fallbackSlug : `${fallbackSlug}-${attempt + 1}`;
        const existingCandidate = await Book.findOne({ slug: candidate }).lean();

        if (!existingCandidate) {
            return { slug: candidate, existingBook: null };
        }
    }

    return { slug: `${fallbackSlug}-${Date.now()}`, existingBook: null };
};

export const checkBookExists = async (title: string) => {
    try {
        await connectToDatabase();

        const userId = await getAuthenticatedUserId();
        const slug = generateSlug(title);

        const existingBook = await Book.findOne({clerkId: userId, slug}).lean();

        if(existingBook) {
            return {
                exists: true,
                book: serializeData(existingBook)
            }
        }

        return {
            exists: false,
        }
    } catch (e) {
        console.error('Error checking book exists', e);
        return {
            exists: false, error: e
        }
    }
}

export const createBook = async (data: CreateBook) => {
    try {
        await connectToDatabase();

        const userId = await getAuthenticatedUserId();

        if (userId !== data.clerkId) {
            return { success: false, error: "Unauthorized" };
        }

        const baseSlug = generateSlug(data.title);
        const { slug, existingBook } = await getAvailableSlug(baseSlug, userId);

        if(existingBook) {
            return {
                success: true,
                data: serializeData(existingBook),
                alreadyExists: true,
            }
        }

        // Todo: Check subscription limits before creating a book
        const { getUserPlan } = await import("@/lib/subscription.server");
        const { PLAN_LIMITS } = await import("@/lib/subscription-constants");

        const plan = await getUserPlan();
        const limits = PLAN_LIMITS[plan];

        const bookCount = await Book.countDocuments({ clerkId: userId });

        if (bookCount >= limits.maxBooks) {
            const { revalidatePath } = await import("next/cache");
            revalidatePath("/");

            return {
                success: false,
                error: `You have reached the maximum number of books allowed for your ${plan} plan (${limits.maxBooks}). Please upgrade to add more books.`,
                isBillingError: true,
            };
        }

        const book = await Book.create({...data, clerkId: userId, slug, totalSegments: 0});

        return {
            success: true,
            data: serializeData(book),
        }
    } catch (e) {
        console.error('Error creating a book', e);

        return {
            success: false,
            error: e,
        }
    }
}

export const getBookBySlug = async (slug: string) => {
    try {
        await connectToDatabase();

        const userId = await getAuthenticatedUserId();
        const book = await Book.findOne({ clerkId: userId, slug }).lean();

        if (!book) {
            return { success: false, error: 'Book not found' };
        }

        return {
            success: true,
            data: serializeData(book)
        }
    } catch (e) {
        console.error('Error fetching book by slug', e);
        return {
            success: false, error: e
        }
    }
}

export const saveBookSegments = async (bookId: string, clerkId: string, segments: TextSegment[]) => {
    try {
        await connectToDatabase();

        const userId = await getAuthenticatedUserId();

        if (userId !== clerkId) {
            return { success: false, error: "Unauthorized" };
        }

        const book = await Book.findOne({ _id: bookId, clerkId: userId }).select('_id').lean();

        if (!book) {
            return { success: false, error: 'Book not found' };
        }

        console.log('Saving book segments...');

        const segmentsToInsert = segments.map(({ text, segmentIndex, pageNumber, wordCount }) => ({
            clerkId: userId, bookId, content: text, segmentIndex, pageNumber, wordCount
        }));

        await BookSegment.insertMany(segmentsToInsert);

        await Book.findOneAndUpdate({ _id: bookId, clerkId: userId }, { totalSegments: segments.length });

        console.log('Book segments saved successfully.');

        return {
            success: true,
            data: { segmentsCreated: segments.length}
        }
    } catch (e) {
        console.error('Error saving book segments', e);

        return {
            success: false,
            error: e,
        }
    }
}

// Searches book segments using MongoDB text search with regex fallback
export const searchBookSegments = async (
    bookId: string,
    query: string,
    limit: number = 5,
    ownerId?: string,
) => {
    try {
        await connectToDatabase();

        const authenticatedUserId = await getOptionalAuthenticatedUserId();
        const userId = authenticatedUserId || ownerId;

        if (!userId) {
            return {
                success: false,
                error: 'Unauthorized',
                data: [],
            };
        }

        console.log(`Searching for: "${query}" in book ${bookId}`);

        const bookObjectId = new mongoose.Types.ObjectId(bookId);
        const book = await Book.findOne({ _id: bookObjectId, clerkId: userId }).select('_id').lean();

        if (!book) {
            return {
                success: false,
                error: 'Book not found',
                data: [],
            };
        }

        // Try MongoDB text search first (requires text index)
        let segments: Record<string, unknown>[] = [];
        try {
            segments = await BookSegment.find({
                clerkId: userId,
                bookId: bookObjectId,
                $text: { $search: query },
            })
                .select('_id bookId content segmentIndex pageNumber wordCount')
                .sort({ score: { $meta: 'textScore' } })
                .limit(limit)
                .lean();
        } catch {
            // Text index may not exist - fall through to regex fallback
            segments = [];
        }

        // Fallback: regex search matching ANY keyword
        if (segments.length === 0) {
            const keywords = query.split(/\s+/).filter((k) => k.length > 2);
            const pattern = keywords.map(escapeRegex).join('|');

            segments = await BookSegment.find({
                clerkId: userId,
                bookId: bookObjectId,
                content: { $regex: pattern, $options: 'i' },
            })
                .select('_id bookId content segmentIndex pageNumber wordCount')
                .sort({ segmentIndex: 1 })
                .limit(limit)
                .lean();
        }

        console.log(`Search complete. Found ${segments.length} results`);

        return {
            success: true,
            data: serializeData(segments),
        };
    } catch (error) {
        console.error('Error searching segments:', error);
        return {
            success: false,
            error: (error as Error).message,
            data: [],
        };
    }
};
