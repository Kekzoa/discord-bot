FROM node:20

WORKDIR /app

COPY package*.json ./

RUN npm install --build-from-source --verbose

COPY . .

CMD ["npm", "start"]