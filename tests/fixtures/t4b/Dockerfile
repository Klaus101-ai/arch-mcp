FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
FROM node:20-alpine
COPY --from=build /app /app
