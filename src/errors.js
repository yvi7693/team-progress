// Ошибки хранилища: ValidationError — неверный запрос (HTTP 400, текст для Claude),
// NotFoundError — нет такого объекта (HTTP 404).
export class ValidationError extends Error {}
export class NotFoundError extends Error {}
