import { NextResponse } from 'next/server';

import { searchBookSegments } from '@/lib/actions/book.actions';

type ToolCallResult = {
    name: string;
    toolCallId: string;
    result?: string;
    error?: string;
};

type VapiToolCallLike = {
    id?: string;
    toolCallId?: string;
    name?: string;
    arguments?: unknown;
    parameters?: unknown;
    function?: {
        name?: string;
        arguments?: unknown;
    };
    tool?: {
        function?: {
            name?: string;
            arguments?: unknown;
        };
    };
    toolCall?: VapiToolCallLike;
};

// Helper function to process book search logic
async function processBookSearch(
    bookId: unknown,
    query: unknown,
    ownerId?: unknown,
): Promise<{ result?: string; error?: string }> {
    // Validate inputs before conversion to prevent null/undefined becoming "null"/"undefined" strings
    if (bookId == null || query == null || query === '' || ownerId == null || ownerId === '') {
        return { error: 'Missing bookId or query' };
    }

    // Convert bookId to string
    const bookIdStr = String(bookId);
    const queryStr = String(query).trim();
    const ownerIdStr = String(ownerId).trim();

    // Additional validation after conversion
    if (
        !bookIdStr ||
        bookIdStr === 'null' ||
        bookIdStr === 'undefined' ||
        !queryStr ||
        !ownerIdStr ||
        ownerIdStr === 'null' ||
        ownerIdStr === 'undefined'
    ) {
        return { error: 'Missing bookId or query' };
    }

    // Execute search
    const searchResult = await searchBookSegments(bookIdStr, queryStr, 3, ownerIdStr);

    // Return results
    if (!searchResult.success || !searchResult.data?.length) {
        return { result: 'No information found about this topic in the book.' };
    }

    const combinedText = searchResult.data
        .map((segment) => (segment as { content: string }).content)
        .join('\n\n');

    return { result: combinedText };
}

export async function GET() {
    return NextResponse.json({ status: 'ok' });
}

// Parse tool arguments that may arrive as a JSON string or an object
function parseArgs(args: unknown): Record<string, unknown> {
    if (!args) return {};
    if (typeof args === 'string') {
        try { return JSON.parse(args); } catch { return {}; }
    }
    return args as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function getOwnerId(args: Record<string, unknown>, body: Record<string, unknown>): unknown {
    const message = asRecord(body.message);
    const assistant = asRecord(message?.assistant);
    const variableValues = asRecord(assistant?.variableValues);

    return (
        args.clerkId ||
        args.userId ||
        args.ownerId ||
        message?.clerkId ||
        message?.userId ||
        variableValues?.clerkId ||
        variableValues?.userId ||
        body.clerkId ||
        body.userId
    );
}

function normalizeToolCall(toolCall: VapiToolCallLike): VapiToolCallLike {
    return toolCall.toolCall || toolCall;
}

function getToolCallName(toolCall: VapiToolCallLike): string {
    const normalized = normalizeToolCall(toolCall);

    return normalized.function?.name || normalized.name || normalized.tool?.function?.name || '';
}

function getToolCallArgs(toolCall: VapiToolCallLike): Record<string, unknown> {
    const normalized = normalizeToolCall(toolCall);

    return parseArgs(
        normalized.function?.arguments ||
        normalized.arguments ||
        normalized.parameters ||
        normalized.tool?.function?.arguments,
    );
}

function getToolCallId(toolCall: VapiToolCallLike): string {
    const normalized = normalizeToolCall(toolCall);

    return normalized.id || normalized.toolCallId || 'unknown-tool-call';
}

function buildToolResult(
    toolCallId: string,
    name: string,
    output: { result?: string; error?: string },
): ToolCallResult {
    return {
        toolCallId,
        name,
        ...(output.error ? { error: output.error } : { result: output.result || '' }),
    };
}

export async function POST(request: Request) {
    try {
        const body = await request.json();

        console.log('Vapi search-book request:', JSON.stringify(body, null, 2));

        // Support multiple Vapi formats
        const functionCall = body?.message?.functionCall;
        const toolCallList =
            body?.message?.toolCallList ||
            body?.message?.toolCalls ||
            body?.message?.toolWithToolCallList;

        // Handle single functionCall format
        if (functionCall) {
            const { name, parameters } = functionCall;
            const parsed = parseArgs(parameters);

            if (name === 'searchBook') {
                const result = await processBookSearch(parsed.bookId, parsed.query, getOwnerId(parsed, body));
                return NextResponse.json({
                    ...result,
                    results: [buildToolResult(functionCall.id || 'function-call', name, result)],
                });
            }

            return NextResponse.json({
                results: [buildToolResult(functionCall.id || 'function-call', name || 'unknown', {
                    error: `Unknown function: ${name}`,
                })],
            });
        }

        // Handle toolCallList format (array of calls)
        if (!toolCallList || toolCallList.length === 0) {
            return NextResponse.json({
                error: 'No tool calls found',
            });
        }

        const results: ToolCallResult[] = [];

        for (const toolCall of toolCallList) {
            const name = getToolCallName(toolCall);
            const args = getToolCallArgs(toolCall);
            const toolCallId = getToolCallId(toolCall);

            if (name === 'searchBook') {
                const searchResult = await processBookSearch(args.bookId, args.query, getOwnerId(args, body));
                results.push(buildToolResult(toolCallId, name, searchResult));
            } else {
                results.push(buildToolResult(toolCallId, name || 'unknown', {
                    error: `Unknown function: ${name}`,
                }));
            }
        }

        return NextResponse.json({ results });
    } catch (error) {
        console.error('Vapi search-book error:', error);
        return NextResponse.json({
            error: 'Error processing request',
        });
    }
}
