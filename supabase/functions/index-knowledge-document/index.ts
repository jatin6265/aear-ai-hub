import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getAuthedClient } from "../_shared/auth.ts";

function cleanExcerpt(value: string, maxLength = 1200) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function inferFallbackExcerpt(title: string, fileType: string) {
  if (fileType === "pdf" || fileType === "docx") {
    return `Indexed metadata for ${title}. Full text extraction for ${fileType.toUpperCase()} can be enabled with a parser worker.`;
  }
  return `Indexed document: ${title}`;
}

function estimateTokenCount(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return Math.max(1, words.length);
}

function isMissingRpcError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
  const message =
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message.toLowerCase()
      : "";
  return code === "PGRST202" || message.includes("could not find the function");
}

function splitIntoChunks(text: string, maxChars = 900, overlap = 140) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [] as string[];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const hardEnd = Math.min(normalized.length, cursor + maxChars);
    let cut = hardEnd;

    if (hardEnd < normalized.length) {
      const lastBoundary = normalized.lastIndexOf(" ", hardEnd);
      if (lastBoundary > cursor + Math.floor(maxChars * 0.55)) {
        cut = lastBoundary;
      }
    }

    const chunk = normalized.slice(cursor, cut).trim();
    if (chunk) chunks.push(chunk);

    if (cut >= normalized.length) break;
    cursor = Math.max(0, cut - overlap);
  }

  return chunks;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "Method not allowed");

  const auth = await getAuthedClient(req);
  if (!auth.ok) return auth.response;

  let documentId = "";
  try {
    const body = await req.json();
    documentId = String(body?.documentId ?? "").trim();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!documentId) return errorResponse(400, "documentId is required");

  const { data: doc, error: docError } = await auth.supabase
    .from("knowledge_documents")
    .select("id, tenant_id, title, file_type, source_type, storage_path, external_url, status")
    .eq("id", documentId)
    .maybeSingle();

  if (docError) return errorResponse(400, "Could not load document", docError.message);
  if (!doc) return errorResponse(404, "Document not found");

  let excerpt = "";
  let chunkCandidates: string[] = [];

  try {
    if (doc.source_type === "upload" && doc.storage_path) {
      const { data: blob, error: downloadError } = await auth.supabase.storage
        .from("knowledge-documents")
        .download(doc.storage_path);

      if (downloadError) throw new Error(downloadError.message);

      if (doc.file_type === "txt" || doc.file_type === "md") {
        const text = await blob.text();
        excerpt = cleanExcerpt(text);
        chunkCandidates = splitIntoChunks(text);
      } else {
        excerpt = inferFallbackExcerpt(doc.title, doc.file_type);
        chunkCandidates = splitIntoChunks(excerpt, 500, 0);
      }
    } else if (doc.external_url) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      try {
        const response = await fetch(doc.external_url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Source returned ${response.status}`);
        const text = await response.text();
        const normalized = text.replace(/<[^>]+>/g, " ");
        excerpt = cleanExcerpt(normalized);
        chunkCandidates = splitIntoChunks(normalized);
      } finally {
        clearTimeout(timeout);
      }
    }

    if (!excerpt) excerpt = inferFallbackExcerpt(doc.title, doc.file_type);
    if (chunkCandidates.length === 0) {
      chunkCandidates = splitIntoChunks(excerpt, 500, 0);
    }

    const { error: deleteChunksError } = await auth.supabase
      .from("knowledge_document_chunks")
      .delete()
      .eq("document_id", doc.id);
    if (deleteChunksError) throw new Error(deleteChunksError.message);

    const chunkRows = chunkCandidates.slice(0, 80).map((chunk, index) => ({
      tenant_id: doc.tenant_id,
      document_id: doc.id,
      chunk_index: index,
      content: chunk,
      token_count: estimateTokenCount(chunk),
    }));

    let chunkIds: string[] = [];
    if (chunkRows.length > 0) {
      const { data: insertedChunks, error: insertChunksError } = await auth.supabase
        .from("knowledge_document_chunks")
        .insert(chunkRows)
        .select("id");
      if (insertChunksError) throw new Error(insertChunksError.message);
      chunkIds = (insertedChunks ?? []).map((row) => row.id);

      // Queue embeddings asynchronously for vector retrieval; fallback-safe when newer RPC isn't deployed yet.
      if (chunkIds.length > 0) {
        const enqueueResults = await Promise.all(
          chunkIds.map((chunkId, index) =>
            auth.supabase.rpc("create_embedding_job", {
              p_source_type: "knowledge_chunk",
              p_source_id: chunkId,
              p_priority: 55,
              p_idempotency_key: `${doc.id}:chunk:${chunkId}`,
              p_payload: {
                document_id: doc.id,
                chunk_index: index,
                source: "index-knowledge-document",
              },
            }),
          ),
        );

        const failed = enqueueResults.filter((result) => result.error && !isMissingRpcError(result.error));
        if (failed.length > 0) {
          throw new Error(failed[0].error?.message ?? "Could not enqueue embedding jobs");
        }
      }
    }

    const { error: updateError } = await auth.supabase
      .from("knowledge_documents")
      .update({
        status: "indexed",
        indexed_at: new Date().toISOString(),
        excerpt,
      })
      .eq("id", doc.id);

    if (updateError) throw new Error(updateError.message);

    return jsonResponse(200, {
      ok: true,
      documentId: doc.id,
      status: "indexed",
      excerpt,
      chunksIndexed: chunkRows.length,
      chunksQueuedForEmbedding: chunkIds.length,
    });
  } catch (error) {
    await auth.supabase
      .from("knowledge_documents")
      .update({
        status: "error",
      })
      .eq("id", doc.id);

    return errorResponse(
      400,
      "Indexing failed",
      error instanceof Error ? error.message : "Unknown indexing error",
    );
  }
});
