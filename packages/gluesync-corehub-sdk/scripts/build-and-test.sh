#!/bin/bash
# Build and test script for Gluesync Node.js SDK

set -e

# Display header
echo "====================================="
echo "Gluesync Node.js SDK Build and Test"
echo "====================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js before continuing."
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed. Please install npm before continuing."
    exit 1
fi

# Display Node.js and npm versions
echo "Node.js version: $(node -v)"
echo "npm version: $(npm -v)"
echo

# Install dependencies
echo "Installing dependencies..."
npm install
echo "Dependencies installed successfully."
echo

# Run linting
echo "Running linter..."
npm run lint
echo "Linting completed successfully."
echo

# Build the project
echo "Building the project..."
npm run build
echo "Build completed successfully."
echo

# Run tests
echo "Running tests..."
npm test
echo "Tests completed successfully."
echo

# Display success message
echo "====================================="
echo "Build and test completed successfully!"
echo "====================================="
