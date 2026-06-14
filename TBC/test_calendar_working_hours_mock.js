const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log("Starting calendar working hours unit test (mocked environment)...");

const adminPath = path.join(__dirname, '..', 'admin.html');
let htmlContent = fs.readFileSync(adminPath, 'utf8');

// We will mock the browser environment variables needed by the script in admin.html
const mockWindow = {
    location: { href: 'http://localhost:3000/admin.html' },
    localStorage: {
        getItem: () => 'dark',
        setItem: () => {}
    },
    document: {
        documentElement: {
            setAttribute: () => {}
        },
        getElementById: (id) => {
            if (id === 'workingHoursTbody') return { innerHTML: '', appendChild: () => {} };
            if (id === 'whGapMinutes') return { value: '' };
            if (id === 'typeBuffersTbody') return { innerHTML: '' };
            return null;
        },
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => []
    },
    adminCalendar: null,
    apiCall: async () => {
        return {
            success: true,
            min_booking_gap_minutes: 30,
            schedule: [
                { day_of_week: 0, start_time: '09:00', end_time: '16:00', is_working_day: 1 },
                { day_of_week: 1, start_time: '08:00', end_time: '16:00', is_working_day: 1 },
                { day_of_week: 2, start_time: '09:00', end_time: '16:00', is_working_day: 0 } // Not working
            ]
        };
    }
};

// Extract the loadWorkingHours function definition from htmlContent
const match = htmlContent.match(/window\.loadWorkingHours\s*=\s*async\s*function\(\)\s*\{([\s\S]*?)\};\s*\/\/\s*---\s*Working\s*Hours\s*---/i) || 
              htmlContent.match(/window\.loadWorkingHours\s*=\s*async\s*function\(\)\s*\{([\s\S]*?)\};\n\n\s*document\.addEventListener\('click'/i);

if (!match) {
    // Let's try finding the function body more generically
    console.error("Could not extract loadWorkingHours via regex. Let's do a substring match.");
    const startIndex = htmlContent.indexOf('window.loadWorkingHours = async function()');
    if (startIndex === -1) {
        throw new Error("Could not find window.loadWorkingHours in admin.html");
    }
    // Simple bracket parser to extract the body
    let openBrackets = 0;
    let bodyStart = htmlContent.indexOf('{', startIndex);
    let bodyEnd = -1;
    for (let i = bodyStart; i < htmlContent.length; i++) {
        if (htmlContent[i] === '{') openBrackets++;
        else if (htmlContent[i] === '}') {
            openBrackets--;
            if (openBrackets === 0) {
                bodyEnd = i;
                break;
            }
        }
    }
    if (bodyEnd === -1) throw new Error("Brackets mismatch for loadWorkingHours");
    const functionBody = htmlContent.substring(bodyStart + 1, bodyEnd);
    runFunctionTest(functionBody);
} else {
    runFunctionTest(match[1]);
}

function runFunctionTest(body) {
    // Create a mock FullCalendar instance with a mock setOption function
    let setOptionCalled = false;
    let passedOptionName = null;
    let passedOptionValue = null;

    mockWindow.adminCalendar = {
        setOption: (name, value) => {
            setOptionCalled = true;
            passedOptionName = name;
            passedOptionValue = value;
        }
    };

    // Execute the body of loadWorkingHours under the mocked environment
    const testFn = new Function('window', 'document', 'adminCalendar', 'apiCall', `
        const WH_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        return (async () => {
            ${body}
        })();
    `);

    testFn(mockWindow, mockWindow.document, mockWindow.adminCalendar, mockWindow.apiCall)
        .then(() => {
            console.log("loadWorkingHours executed successfully in mock environment.");
            assert.strictEqual(setOptionCalled, true, "setOption should have been called on adminCalendar");
            assert.strictEqual(passedOptionName, 'businessHours', "Option set should be 'businessHours'");
            
            console.log("Resulting businessHours:", JSON.stringify(passedOptionValue, null, 2));
            assert.strictEqual(passedOptionValue.length, 2, "Should have filtered is_working_day: 0 and returned 2 days");
            
            assert.deepStrictEqual(passedOptionValue[0], {
                daysOfWeek: [0],
                startTime: '09:00',
                endTime: '16:00'
            }, "First working day configuration mismatch");
            
            assert.deepStrictEqual(passedOptionValue[1], {
                daysOfWeek: [1],
                startTime: '08:00',
                endTime: '16:00'
            }, "Second working day configuration mismatch");

            console.log("✓ Unit test passed successfully: FullCalendar businessHours dynamically binds correctly!");
            process.exit(0);
        })
        .catch(err => {
            console.error("❌ Unit test FAILED:", err);
            process.exit(1);
        });
}
