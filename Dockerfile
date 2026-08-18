# True Kind portal — joins the existing truehr Docker network,
# so it reaches Postgres at truehr-db:5432 with no published DB port.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/server.js"]
