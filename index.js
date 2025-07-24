require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

if (!process.env.GEMINI_API_KEY) {
  console.error("FATAL ERROR: GEMINI_API_KEY is not defined in .env file.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const meetings = new Map();

const systemPrompt = `You are Martin, an experienced B2B sales executive at LeadMate CRM. You're conducting an outbound sales call via chat to help businesses understand the value of our advanced CRM solution.

Your personality and approach:
- Professional, friendly, and conversational
- Genuinely interested in helping prospects solve their problems
- Skilled at asking qualifying questions
- Confident but not pusty
- Empathetic to business challenges
- Goal-oriented but relationship-focused

Your objective: Book a demo or follow-up call by the end of the conversation.

Meeting Scheduling Protocol:
When a user expresses interest in scheduling a meeting, demo, or call (phrases like "let's have a meet", "schedule a demo", "book a call", "set up a meeting", etc.), you should:

1. Express enthusiasm about scheduling the meeting
2. Ask for their preferred time/date
3. Confirm their contact details (name, email, phone)
4. Use the special format: [SCHEDULE_MEETING] followed by the meeting details

Meeting request format:
[SCHEDULE_MEETING]
Name: [User's name]
Email: [User's email] 
Phone: [User's phone]
Preferred Date: [Date they mentioned]
Preferred Time: [Time they mentioned]
Meeting Type: [Demo/Call/Consultation]
Notes: [Any additional notes]
[/SCHEDULE_MEETING]

Conversation Flow:
1. Cold Call Introduction: Warm, personalized opening
2. Qualifying Questions: Understand their current situation and pain points
3. Value Proposition: Present relevant benefits based on their needs
4. Objection Handling: Address concerns professionally
5. Closing: Guide toward scheduling a demo

Guidelines:
- Keep responses concise (2-3 sentences max initially)
- Ask one question at a time
- Always move the conversation forward
- If they object, acknowledge and redirect
- Be persistent but respectful
- When scheduling, collect all necessary details before confirming

Remember: This is a professional sales interaction. Stay focused on business value and building trust.`;

// Helper function to validate and clean history
function validateAndCleanHistory(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return [];
  }

  // Filter out any invalid messages
  const validHistory = history.filter(msg => 
    msg && 
    msg.role && 
    msg.content && 
    typeof msg.content === 'string' &&
    (msg.role === 'user' || msg.role === 'assistant')
  );

  // Ensure history starts with 'user' role
  if (validHistory.length > 0 && validHistory[0].role === 'assistant') {
    // Remove the first assistant message if it's at the beginning
    validHistory.shift();
  }

  // Convert to Gemini format
  return validHistory.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));
}

// Function to parse meeting request from AI response
function parseMeetingRequest(response) {
  const meetingRegex = /\[SCHEDULE_MEETING\]([\s\S]*?)\[\/SCHEDULE_MEETING\]/;
  const match = response.match(meetingRegex);
  
  if (!match) return null;
  
  const meetingData = match[1];
  const meeting = {};
  
  // Parse each field
  const nameMatch = meetingData.match(/Name:\s*(.+)/i);
  const emailMatch = meetingData.match(/Email:\s*(.+)/i);
  const phoneMatch = meetingData.match(/Phone:\s*(.+)/i);
  const dateMatch = meetingData.match(/Preferred Date:\s*(.+)/i);
  const timeMatch = meetingData.match(/Preferred Time:\s*(.+)/i);
  const typeMatch = meetingData.match(/Meeting Type:\s*(.+)/i);
  const notesMatch = meetingData.match(/Notes:\s*(.+)/i);
  
  if (nameMatch) meeting.name = nameMatch[1].trim();
  if (emailMatch) meeting.email = emailMatch[1].trim();
  if (phoneMatch) meeting.phone = phoneMatch[1].trim();
  if (dateMatch) meeting.preferredDate = dateMatch[1].trim();
  if (timeMatch) meeting.preferredTime = timeMatch[1].trim();
  if (typeMatch) meeting.meetingType = typeMatch[1].trim();
  if (notesMatch) meeting.notes = notesMatch[1].trim();
  
  return meeting;
}
function createMeetingLink(meetingId) {

  return `https://meet.leadmate.com/join/${meetingId}`;
}

function generateCalendarInvite(meeting, meetingId) {
  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); 
  

  const formatDate = (date) => {
    return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  };
  
  const calendarUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=LeadMate CRM Demo&dates=${formatDate(startDate)}/${formatDate(endDate)}&details=Meeting with Sarah from LeadMate CRM%0A%0AMeeting Link: ${createMeetingLink(meetingId)}&location=${createMeetingLink(meetingId)}`;
  
  return calendarUrl;
}


app.get('/', (req, res) => {
  res.json({ status: 'Server is running', timestamp: new Date().toISOString() });
});

app.get('/meetings', (req, res) => {
  const allMeetings = Array.from(meetings.entries()).map(([id, meeting]) => ({
    id,
    ...meeting
  }));
  res.json({ meetings: allMeetings });
});


app.get('/meetings/:id', (req, res) => {
  const meeting = meetings.get(req.params.id);
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }
  res.json({ meeting: { id: req.params.id, ...meeting } });
});

app.post('/chat', async (req, res) => {
  try {
    const { message, history } = req.body;

    // Validate input
    if (!message || typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ 
        error: 'Request body must contain a valid "message" string.' 
      });
    }

    if (!Array.isArray(history)) {
      return res.status(400).json({ 
        error: 'Request body must contain "history" as an array.' 
      });
    }

    console.log('Received message:', message);
    console.log('Received history length:', history.length);

    // Clean and validate history
    const geminiHistory = validateAndCleanHistory(history);

    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: systemPrompt,
    });

    const chat = model.startChat({
      history: geminiHistory,
      generationConfig: {
        maxOutputTokens: 300,
        temperature: 0.7,
      },
    });

    const result = await chat.sendMessage(message.trim());
    const response = await result.response;
    let text = response.text();


    const meetingRequest = parseMeetingRequest(text);
    let meetingInfo = null;

    if (meetingRequest) {

      const meetingId = uuidv4();
      const meeting = {
        ...meetingRequest,
        id: meetingId,
        status: 'scheduled',
        createdAt: new Date().toISOString(),
        meetingLink: createMeetingLink(meetingId),
        calendarLink: generateCalendarInvite(meetingRequest, meetingId)
      };

      meetings.set(meetingId, meeting);


      meetingInfo = {
        id: meetingId,
        meetingLink: meeting.meetingLink,
        calendarLink: meeting.calendarLink,
        scheduledFor: `${meeting.preferredDate} at ${meeting.preferredTime}`,
        meetingType: meeting.meetingType || 'Demo'
      };


      text = text.replace(/\[SCHEDULE_MEETING\][\s\S]*?\[\/SCHEDULE_MEETING\]/g, '').trim();

      text += `\n\n✅ Perfect! I've scheduled your ${meetingInfo.meetingType.toLowerCase()} for ${meetingInfo.scheduledFor}. 
      
📅 **Meeting Details:**
• Meeting ID: ${meetingId}
• Join Link: ${meetingInfo.meetingLink}
• Add to Calendar: Click the calendar link below

I'll send you a confirmation email shortly. Looking forward to our meeting!`;

      console.log('Meeting scheduled:', meeting);
    }

    console.log('AI Response:', text);
    
    const responseData = { 
      message: text,
      ...(meetingInfo && { meeting: meetingInfo })
    };
    
    res.json(responseData);

  } catch (error) {
    console.error('Error in /chat endpoint:', error);
    
    // Provide more specific error messages
    if (error.message?.includes('First content should be with role')) {
      console.error('History validation failed - this should not happen after our fixes');
      return res.status(400).json({ 
        error: 'Invalid conversation history format. Please try starting a new conversation.' 
      });
    }
    
    res.status(500).json({ 
      error: 'An internal server error occurred. Please try again.' 
    });
  }
});


app.delete('/meetings/:id', (req, res) => {
  const meetingId = req.params.id;
  const meeting = meetings.get(meetingId);
  
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }
  
  meetings.delete(meetingId);
  res.json({ message: 'Meeting cancelled successfully', meetingId });
});


app.put('/meetings/:id', (req, res) => {
  const meetingId = req.params.id;
  const meeting = meetings.get(meetingId);
  
  if (!meeting) {
    return res.status(404).json({ error: 'Meeting not found' });
  }
  
  const { preferredDate, preferredTime } = req.body;
  
  if (preferredDate) meeting.preferredDate = preferredDate;
  if (preferredTime) meeting.preferredTime = preferredTime;
  meeting.updatedAt = new Date().toISOString();
  
  meetings.set(meetingId, meeting);
  
  res.json({ 
    message: 'Meeting rescheduled successfully', 
    meeting: { id: meetingId, ...meeting }
  });
});

app.listen(port, () => {
  console.log(`Server is running successfully on http://localhost:${port}`);
  console.log(`Meeting management available at:`);
  console.log(`- GET /meetings - List all meetings`);
  console.log(`- GET /meetings/:id - Get specific meeting`);
  console.log(`- DELETE /meetings/:id - Cancel meeting`);
  console.log(`- PUT /meetings/:id - Reschedule meeting`);
});

app.get('/',(req,res)=>{
  res.send("hey ai ass chat bot");
});

module.exports = app;