const http = require('http');
const fs = require('fs');
const path = require('path');

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
  let filePath = req.url === '/' || req.url === '/docs' ? 
    path.join(DOCS_DIR, 'index.html') : 
    path.join(__dirname, req.url);
  
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
      contentType = 'image/jpg';
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
  console.log(`Gluesync Conductor API Documentation server running at http://localhost:${PORT}/docs`);
  console.log(`You can also access it at http://localhost:${PORT}/`);
});
