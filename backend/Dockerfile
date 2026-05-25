FROM nikolaik/python-nodejs:python3.10-nodejs18

WORKDIR /app

# Copy package files and install Node dependencies
COPY package.json ./
RUN npm install

# Copy requirements and install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source code
COPY . .

# Ensure startup script has execution permissions
RUN chmod +x start.sh

# Expose the Python FastAPI backend port (which will route to WhatsApp internally)
EXPOSE 8000

CMD ["./start.sh"]
