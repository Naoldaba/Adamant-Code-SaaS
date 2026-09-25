import type { RequestHandler } from "express";
import { z } from "zod";
import { ApiError } from "../lib/errors.js";

export function validateQuery<T extends z.ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return next(new ApiError(400, "VALIDATION_ERROR", parsed.error.message));
    req.query = parsed.data as any;
    next();
  };
}

export function validateBody<T extends z.ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return next(new ApiError(400, "VALIDATION_ERROR", parsed.error.message));
    req.body = parsed.data;
    next();
  };
}

const uuidParamSchema = z.string().uuid();

/**
 * Guard a UUID route param. A malformed id is treated as a missing resource (404)
 * rather than surfacing the Postgres "invalid input syntax for type uuid" error as
 * a 500 — and, for owner-scoped resources, 404 keeps the "never leak existence"
 * contract consistent whether the id is foreign, missing, or malformed.
 */
export function requireUuidParam(name: string, notFoundMessage = "Not found"): RequestHandler {
  return (req, _res, next) => {
    if (!uuidParamSchema.safeParse(req.params[name]).success) {
      return next(new ApiError(404, "NOT_FOUND", notFoundMessage));
    }
    next();
  };
}
