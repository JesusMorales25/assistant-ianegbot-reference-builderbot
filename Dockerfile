FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV PORT=3008
ENV HOST=0.0.0.0
EXPOSE 3008

CMD ["npm", "start"]
