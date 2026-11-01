// The engine is compiled WITHOUT DOM and WITHOUT Node type libraries (see engine/tsconfig.json),
// so it cannot accidentally use browser-only or Node-only APIs. structuredClone is a standard
// global available in every modern browser and in Node >= 17, so it is declared here explicitly.
declare function structuredClone<T>(value: T): T;
