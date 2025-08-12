import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 8080;
const DOCS_DIR = path.join(__dirname, 'docs');
const SWAGGER_FILE = path.join(__dirname, 'swagger.yaml');

const server = http.createServer((req, res) => {
  console.log(`Request for ${req.url}`);

  // Serve the Swagger YAML file
  if (req.url === '/swagger.yaml') {
    fs.readFile(SWAGGER_FILE, (err, content) => {
      if (err) {
        res.writeHead(404);
        res.end('File not found');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/yaml' });
      res.end(content);
    });
    return;
  }

  // Serve the docs/index.html or redirect to it
  const filePath =
    req.url === '/' || req.url === '/docs'
      ? path.join(DOCS_DIR, 'index.html')
      : path.join(__dirname, req.url || '');

  const extname = path.extname(filePath);
  let contentType = 'text/html';

  switch (extname) {
    case '.js':
      contentType = 'text/javascript';
      break;
    case '.css':
      contentType = 'text/css';
      break;
    case '.json':
      contentType = 'application/json';
      break;
    case '.png':
      contentType = 'image/png';
      break;
    case '.jpg':
    case '.jpeg':
      contentType = 'image/jpeg';
      break;
    case '.yaml':
    case '.yml':
      contentType = 'application/yaml';
      break;
    case '.svg':
      contentType = 'image/svg+xml';
      break;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        console.log(`File not found: ${filePath}`);
        res.writeHead(404);
        res.end('File not found');
      } else {
        console.error(`Server error: ${err.code}`);
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content, 'utf-8');
  });
});

server.listen(PORT, () => {
  console.log(
    `Gluesync Conductor API Documentation server running at http://localhost:${PORT}/docs`,
  );
  console.log(`You can also access it at http://localhost:${PORT}/`);
});
