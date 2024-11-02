# backend/chatbot_service.py
from dotenv import load_dotenv
from flask import Blueprint, request, jsonify
import base64
import io
from PIL import Image
import os
import requests
from datetime import datetime
# from transformers import pipeline
load_dotenv()  # Load environment variables from .env file

chatbot_bp = Blueprint('chatbot', __name__)

OPENROUTER_API_KEY = os.getenv('REACT_APP_OPENROUTER_API_KEY')
if OPENROUTER_API_KEY is None:
    raise ValueError("OPENROUTER_API_KEY environment variable is not set")
SITE_URL = "http://localhost:3000"  # Update with your actual URL
APP_NAME = "Trading Dashboard Assistant"

# Create screenshots directory if it doesn't exist
SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), 'screenshots')
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

def save_screenshot(base64_image):
  """Save base64 image to file with organized naming"""
  # Remove base64 prefix if present
  if ',' in base64_image:
      base64_image = base64_image.split(',')[1]
  
  # Generate filename with timestamp
  timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
  filename = f'dashboard_screenshot_{timestamp}.jpg'
  filepath = os.path.join(SCREENSHOT_DIR, filename)
  
  # Save image
  with open(filepath, 'wb') as f:
      f.write(base64.b64decode(base64_image))
  
  return filepath


# # Initialize vision-language model
# try:
#   from transformers import AutoProcessor, AutoModelForVisionAndLanguage
#   processor = AutoProcessor.from_pretrained("llava-hf/llava-1.5-7b-hf")
#   model = AutoModelForVisionAndLanguage.from_pretrained("llava-hf/llava-1.5-7b-hf")
# except:
#   print("Using fallback text-only model")
#   # Fallback to simpler model if VLM loading fails
#   qa_pipeline = pipeline("question-answering")


def analyze_image(image_path, query):
  """Analyze image using OpenRouter API"""
  with open(image_path, 'rb') as image_file:
      # Convert image to base64
      image_base64 = base64.b64encode(image_file.read()).decode('utf-8')
      
      payload = {
          "model": "meta-llama/llama-3.2-11b-vision-instruct:free",
          "messages": [
              {
                  "role": "user",
                  "content": [
                      {
                          "type": "text",
                          "text": query
                      },
                      {
                          "type": "image_url",
                          "image_url": {
                              "url": f"data:image/jpeg;base64,{image_base64}"
                          }
                      }
                  ]
              }
          ]
      }

      headers = {
          "Authorization": f"Bearer {OPENROUTER_API_KEY}",
          "HTTP-Referer": SITE_URL,
          "X-Title": APP_NAME,
          "Content-Type": "application/json"
      }

      response = requests.post(
          "https://openrouter.ai/api/v1/chat/completions",
          headers=headers,
          json=payload
      )

      if response.status_code == 200:
          return response.json()['choices'][0]['message']['content']
      else:
          raise Exception(f"API Error: {response.text}")


def analyze_query(query: str) -> str:
    """
    Analyze a query using the OpenRouter model.

    Args:
    query (str): The query to analyze

    Returns:
    str: The response from the OpenRouter model
    """
    payload = {
        "model": "meta-llama/llama-3.2-11b-vision-instruct:free",
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": query
                    }
                ]
            }
        ]
    }

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "HTTP-Referer": SITE_URL,
        "X-Title": APP_NAME,
        "Content-Type": "application/json"
    }

    response = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers=headers,
        json=payload
    )

    if response.status_code == 200:
        return response.json()['choices'][0]['message']['content']
    else:
        raise Exception(f"API Error: {response.text}")

@chatbot_bp.route('/api/chat', methods=['POST'])
def analyze_dashboard():
  capture = True
  data = request.json
  try:

      if capture:
        
        screenshot = data.get('screenshot')
        print(screenshot)
        query = data.get('query', "What can you tell me about this trading dashboard?")
        print(query)
        # Save screenshot
        image_path = save_screenshot(screenshot)
        print(image_path)

        # Analyze with OpenRouter
        analysis = analyze_image(image_path, query)
        print(analysis)

        return jsonify({
            "success": True,
            "response": analysis
        })

      else:
        query = data.get('query', "What can you tell me about this trading dashboard?")
        analysis = analyze_query(query)
        # Simple text response when no image is provided
        return jsonify({
            "success": True,
            "response": analysis
        })


  except Exception as e:
      print(e)
      return jsonify({
          "response": "I can see the trading dashboard. What specific information would you like to know?", 
          "success": False,
          "error": str(e)
      }), 500

# @chatbot_bp.route('/api/chat', methods=['POST'])
# def process_chat():
#   print("meassage recieved")
#   data = request.json
#   query = data.get('query')
#   screenshot = data.get('screenshot')


#   # Convert base64 screenshot to image
#   image_data = base64.b64decode(screenshot.split(',')[1])
#   image = Image.open(io.BytesIO(image_data))

#   try:
#       # Process with vision-language model
#       inputs = processor(image, query, return_tensors="pt")
#       outputs = model.generate(**inputs)
#       response = processor.decode(outputs[0], skip_special_tokens=True)
#   except Exception as e:
#       print(f"VLM processing error: {e}")
#       # Fallback to simpler response
#       response = "I can see the trading dashboard. What specific information would you like to know?"

#   return jsonify({"response": response})
