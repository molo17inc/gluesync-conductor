#!/bin/bash

echo "=====================================
Gluesync Node.js SDK Build
====================================="
echo "Node.js version: $(node -v)"
echo "npm version: $(npm -v)"
echo ""

echo "Installing dependencies..."
npm install
echo "Dependencies installed successfully."
echo ""

echo "Running linter..."
npm run lint
echo "Linting completed successfully."
echo ""

echo "Building the project..."
npm run build
echo "Build completed successfully."
echo ""

echo "Build process completed successfully!"
