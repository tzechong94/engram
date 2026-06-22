// pdf-parse ships no types for its lib entry point (we import that directly to
// avoid the package main's debug code that reads a sample PDF off disk).
declare module 'pdf-parse/lib/pdf-parse.js' {
  function pdfParse(data: Buffer): Promise<{ text: string; numpages: number; info: unknown }>;
  export default pdfParse;
}
