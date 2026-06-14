import sys
keywords = ['bookings', 'refund', '/refund', 'bk-action-refund']
with open('admin.html', 'r', encoding='utf-8', errors='ignore') as f:
    for i, line in enumerate(f):
        line_str = line.strip()
        matched = [kw for kw in keywords if kw in line_str]
        if matched:
            sys.stdout.buffer.write(f"{i+1} ({', '.join(matched)}): {line_str}\n".encode('utf-8', errors='replace'))
