#!/usr/bin/env python3
"""
Seed script for OpenMemory - Downloads public datasets and inserts into PostgreSQL + OpenSearch.

Usage:
    python scripts/seed-data.py [--count N] [--source quotes|facts|wiki]

Requirements:
    pip install psycopg2-binary requests

Environment variables (with defaults):
    DATABASE_URL=postgres://openmemory:openmemory@localhost:5432/openmemory
    OPENSEARCH_URL=http://localhost:9200
"""

import argparse
import json
import os
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone
from typing import Generator

import psycopg2
import requests

# Configuration
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://openmemory:openmemory@localhost:5432/openmemory"
)
OPENSEARCH_URL = os.getenv("OPENSEARCH_URL", "http://localhost:9200").rstrip("/")
OPENSEARCH_INDEX = "memories"

# Public dataset URLs
DATASETS = {
    "quotes": [
        # Famous quotes dataset (~500 quotes)
        "https://raw.githubusercontent.com/dwyl/quotes/main/quotes.json",
    ],
    "facts": [
        # Random facts
        "https://raw.githubusercontent.com/assafelovic/facts-api/master/facts.json",
    ],
    "wiki": [
        # Simple English Wikipedia summaries (sample)
        "https://raw.githubusercontent.com/dariusk/corpora/master/data/words/common.json",
    ],
}

# Tag categories for generating varied tags
TAG_CATEGORIES = {
    "topic": ["science", "history", "technology", "philosophy", "life", "wisdom", "nature", "art", "business", "education"],
    "type": ["quote", "fact", "insight", "tip", "lesson", "observation"],
    "source": ["book", "speech", "interview", "article", "research", "experience"],
}


def parse_database_url(url: str) -> dict:
    """Parse PostgreSQL connection URL into components."""
    # Format: postgres://user:password@host:port/database
    url = url.replace("postgres://", "").replace("postgresql://", "")
    auth, rest = url.split("@")
    user, password = auth.split(":")
    host_port, database = rest.split("/")
    if ":" in host_port:
        host, port = host_port.split(":")
    else:
        host, port = host_port, "5432"
    return {
        "host": host,
        "port": int(port),
        "user": user,
        "password": password,
        "database": database,
    }


def ensure_opensearch_index():
    """Create OpenSearch index if it doesn't exist."""
    index_url = f"{OPENSEARCH_URL}/{OPENSEARCH_INDEX}"

    # Check if index exists
    resp = requests.head(index_url)
    if resp.status_code == 200:
        print(f"OpenSearch index '{OPENSEARCH_INDEX}' already exists")
        return

    # Create index with mappings
    mapping = {
        "settings": {
            "number_of_shards": 1,
            "number_of_replicas": 0
        },
        "mappings": {
            "properties": {
                "id": {"type": "keyword"},
                "user_id": {"type": "keyword"},
                "content": {"type": "text", "analyzer": "standard"},
                "summary": {"type": "text"},
                "importance_score": {"type": "float"},
                "tags": {"type": "keyword"},
                "created_at": {"type": "date"},
                "updated_at": {"type": "date"}
            }
        }
    }

    resp = requests.put(index_url, json=mapping)
    if resp.status_code in (200, 201):
        print(f"Created OpenSearch index '{OPENSEARCH_INDEX}'")
    else:
        print(f"Warning: Failed to create index: {resp.text}")


def ensure_postgres_table(conn):
    """Create PostgreSQL table if it doesn't exist."""
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS memory_index (
                id UUID PRIMARY KEY,
                user_id TEXT,
                summary TEXT,
                importance_score REAL NOT NULL DEFAULT 0.5,
                tags TEXT[] NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        conn.commit()
        print("PostgreSQL table 'memory_index' ready")


def download_quotes() -> Generator[dict, None, None]:
    """Download and parse quotes dataset."""
    url = DATASETS["quotes"][0]
    print(f"Downloading quotes from {url}...")

    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    for item in data:
        # Handle different quote formats
        if isinstance(item, dict):
            text = item.get("text") or item.get("quote") or item.get("content", "")
            author = item.get("author") or item.get("source", "Unknown")
        else:
            text = str(item)
            author = "Unknown"

        if text:
            yield {
                "content": f'"{text}" - {author}',
                "summary": f"Quote by {author}",
                "tags": random.sample(TAG_CATEGORIES["topic"], k=random.randint(1, 3)) + ["quote"],
                "importance": round(random.uniform(0.3, 0.9), 2),
            }


def download_programming_wisdom() -> Generator[dict, None, None]:
    """Generate programming wisdom and tips."""
    wisdom = [
        ("Write code that is easy to delete, not easy to extend.", "Programming wisdom", ["programming", "design"]),
        ("Premature optimization is the root of all evil.", "Donald Knuth", ["programming", "optimization"]),
        ("Make it work, make it right, make it fast.", "Kent Beck", ["programming", "process"]),
        ("Programs must be written for people to read, and only incidentally for machines to execute.", "SICP", ["programming", "readability"]),
        ("The best code is no code at all.", "Jeff Atwood", ["programming", "simplicity"]),
        ("Code is like humor. When you have to explain it, it's bad.", "Cory House", ["programming", "clarity"]),
        ("First, solve the problem. Then, write the code.", "John Johnson", ["programming", "problem-solving"]),
        ("Any fool can write code that a computer can understand. Good programmers write code that humans can understand.", "Martin Fowler", ["programming", "clean-code"]),
        ("Debugging is twice as hard as writing the code in the first place.", "Brian Kernighan", ["programming", "debugging"]),
        ("The most dangerous phrase in the language is: We've always done it this way.", "Grace Hopper", ["wisdom", "innovation"]),
        ("Simplicity is prerequisite for reliability.", "Edsger Dijkstra", ["programming", "simplicity"]),
        ("If you can't explain it simply, you don't understand it well enough.", "Albert Einstein", ["wisdom", "teaching"]),
        ("The only way to learn a new programming language is by writing programs in it.", "Dennis Ritchie", ["programming", "learning"]),
        ("It's not a bug – it's an undocumented feature.", "Anonymous", ["programming", "humor"]),
        ("Good code is its own best documentation.", "Steve McConnell", ["programming", "documentation"]),
    ]

    for text, source, tags in wisdom:
        yield {
            "content": f'"{text}" - {source}',
            "summary": f"Wisdom from {source}",
            "tags": tags + ["wisdom"],
            "importance": round(random.uniform(0.6, 0.95), 2),
        }


def download_tech_facts() -> Generator[dict, None, None]:
    """Generate technology facts."""
    facts = [
        ("The first computer virus was created in 1983 and was called the Elk Cloner.", ["technology", "history", "security"]),
        ("Python was named after Monty Python, not the snake.", ["programming", "python", "trivia"]),
        ("Git was created by Linus Torvalds in 2005 for Linux kernel development.", ["git", "technology", "history"]),
        ("The first website ever created is still online at info.cern.ch.", ["web", "history", "internet"]),
        ("JavaScript was created in just 10 days by Brendan Eich in 1995.", ["javascript", "programming", "history"]),
        ("The term 'bug' in computing came from an actual moth found in a computer in 1947.", ["programming", "history", "trivia"]),
        ("The first 1GB hard drive, introduced in 1980, weighed 550 pounds and cost $40,000.", ["technology", "history", "hardware"]),
        ("Over 90% of the world's data has been created in the last two years.", ["data", "technology", "statistics"]),
        ("The average person spends about 7 hours a day looking at screens.", ["technology", "health", "statistics"]),
        ("NASA's computers in 1969 had less processing power than a modern calculator.", ["technology", "history", "space"]),
        ("The first email was sent by Ray Tomlinson to himself in 1971.", ["email", "history", "internet"]),
        ("Rust has been voted the most loved programming language for multiple years.", ["rust", "programming", "survey"]),
        ("Docker containers share the host OS kernel, making them lighter than VMs.", ["docker", "devops", "containers"]),
        ("Kubernetes was originally developed by Google and is now maintained by CNCF.", ["kubernetes", "devops", "cloud"]),
        ("PostgreSQL started as a project at UC Berkeley in 1986.", ["postgresql", "database", "history"]),
    ]

    for text, tags in facts:
        yield {
            "content": text,
            "summary": text[:50] + "..." if len(text) > 50 else text,
            "tags": tags + ["fact"],
            "importance": round(random.uniform(0.4, 0.8), 2),
        }


def download_life_tips() -> Generator[dict, None, None]:
    """Generate life and productivity tips."""
    tips = [
        ("Use the Pomodoro Technique: 25 minutes of focused work, 5 minutes break.", ["productivity", "time-management"]),
        ("Keep a daily journal to track progress and reflect on learnings.", ["productivity", "self-improvement"]),
        ("Practice active listening by summarizing what others say before responding.", ["communication", "relationships"]),
        ("Set SMART goals: Specific, Measurable, Achievable, Relevant, Time-bound.", ["goals", "planning"]),
        ("Take regular breaks to prevent burnout and maintain creativity.", ["health", "productivity"]),
        ("Learn to say no to protect your time and energy for what matters most.", ["boundaries", "self-care"]),
        ("Review your code after a good night's sleep - fresh eyes catch more bugs.", ["programming", "productivity"]),
        ("Document your decisions and their rationale for future reference.", ["documentation", "work"]),
        ("Invest in a good chair and monitor setup - your body will thank you.", ["health", "ergonomics"]),
        ("Automate repetitive tasks to free up time for creative work.", ["automation", "productivity"]),
        ("Keep learning: dedicate at least 30 minutes daily to skill development.", ["learning", "growth"]),
        ("Write tests before fixing bugs to ensure they don't come back.", ["testing", "programming"]),
        ("Use version control for everything, not just code.", ["git", "organization"]),
        ("Take walks to boost creativity and problem-solving ability.", ["health", "creativity"]),
        ("Teach others what you learn - it's the best way to solidify knowledge.", ["learning", "teaching"]),
    ]

    for text, tags in tips:
        yield {
            "content": text,
            "summary": "Tip: " + text[:40] + "...",
            "tags": tags + ["tip"],
            "importance": round(random.uniform(0.5, 0.85), 2),
        }


def generate_synthetic_memories(count: int) -> Generator[dict, None, None]:
    """Generate synthetic memory entries for testing."""
    templates = [
        ("User prefers {tool} over {alt} for {task}.", ["preference", "tool"], 0.8),
        ("Project uses {framework} with {feature} enabled.", ["project", "tech-stack"], 0.7),
        ("Important: Always {action} before {other_action}.", ["workflow", "best-practice"], 0.9),
        ("Note: {topic} documentation is at {url}.", ["documentation", "reference"], 0.5),
        ("Learned that {concept} works best when {condition}.", ["learning", "insight"], 0.6),
        ("Meeting decision: We will {decision} starting {timeframe}.", ["decision", "meeting"], 0.75),
        ("Bug fix: {issue} was caused by {cause}.", ["bugfix", "debugging"], 0.65),
        ("Configuration: Set {setting} to {value} for {environment}.", ["config", "devops"], 0.55),
    ]

    tools = ["Docker", "Kubernetes", "Terraform", "Ansible", "Git", "VS Code", "Vim", "Rust", "Python", "TypeScript"]
    frameworks = ["Next.js", "React", "Vue", "Svelte", "FastAPI", "Axum", "Express", "Django", "Rails", "Spring"]
    features = ["SSR", "TypeScript", "hot reload", "caching", "authentication", "logging", "monitoring"]
    actions = ["test", "review", "backup", "document", "validate", "check"]
    topics = ["API", "authentication", "deployment", "testing", "CI/CD", "monitoring", "security"]

    generated = 0
    while generated < count:
        template, base_tags, base_importance = random.choice(templates)

        content = template.format(
            tool=random.choice(tools),
            alt=random.choice(tools),
            task=random.choice(["development", "deployment", "testing", "CI/CD", "monitoring"]),
            framework=random.choice(frameworks),
            feature=random.choice(features),
            action=random.choice(actions),
            other_action=random.choice(actions),
            topic=random.choice(topics),
            url=f"https://docs.example.com/{random.choice(topics).lower()}",
            concept=random.choice(topics),
            condition=random.choice(["combined with caching", "in production", "with proper error handling"]),
            decision=random.choice(["use microservices", "adopt TypeScript", "implement CI/CD", "migrate to cloud"]),
            timeframe=random.choice(["next sprint", "Q2", "immediately", "after testing"]),
            issue=random.choice(["memory leak", "timeout error", "race condition", "null pointer"]),
            cause=random.choice(["missing null check", "incorrect config", "race condition", "memory leak"]),
            setting=random.choice(["LOG_LEVEL", "MAX_CONNECTIONS", "TIMEOUT", "CACHE_TTL"]),
            value=random.choice(["debug", "100", "30s", "3600"]),
            environment=random.choice(["production", "staging", "development", "testing"]),
        )

        # Vary importance slightly
        importance = round(base_importance + random.uniform(-0.15, 0.15), 2)
        importance = max(0.1, min(1.0, importance))

        # Add some random tags
        extra_tags = random.sample(TAG_CATEGORIES["topic"], k=random.randint(0, 2))

        yield {
            "content": content,
            "summary": content[:60] + "..." if len(content) > 60 else content,
            "tags": base_tags + extra_tags,
            "importance": importance,
        }
        generated += 1


def insert_memory(conn, opensearch_url: str, memory: dict) -> str:
    """Insert a single memory into PostgreSQL and OpenSearch."""
    memory_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    # Randomize creation time within the last 90 days for variety
    days_ago = random.randint(0, 90)
    created_at = now - timedelta(days=days_ago, hours=random.randint(0, 23))

    # Insert into PostgreSQL
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO memory_index (id, user_id, summary, importance_score, tags, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                str(memory_id),
                None,
                memory.get("summary"),
                memory["importance"],
                memory["tags"],
                created_at,
                created_at,
            )
        )

    # Insert into OpenSearch
    doc = {
        "id": str(memory_id),
        "user_id": None,
        "content": memory["content"],
        "summary": memory.get("summary"),
        "importance_score": memory["importance"],
        "tags": memory["tags"],
        "created_at": created_at.isoformat(),
        "updated_at": created_at.isoformat(),
    }

    doc_url = f"{opensearch_url}/{OPENSEARCH_INDEX}/_doc/{memory_id}"
    resp = requests.put(doc_url, json=doc)

    if resp.status_code not in (200, 201):
        raise Exception(f"OpenSearch insert failed: {resp.text}")

    return str(memory_id)


def main():
    parser = argparse.ArgumentParser(description="Seed OpenMemory with demo data")
    parser.add_argument(
        "--count", "-c",
        type=int,
        default=1000,
        help="Number of memories to generate (default: 1000)"
    )
    parser.add_argument(
        "--source", "-s",
        choices=["all", "quotes", "synthetic", "mixed"],
        default="mixed",
        help="Data source: all (download all), quotes (online quotes), synthetic (generated), mixed (default)"
    )
    parser.add_argument(
        "--clear",
        action="store_true",
        help="Clear existing data before seeding"
    )
    args = parser.parse_args()

    print("=" * 60)
    print("OpenMemory Data Seeder")
    print("=" * 60)
    print(f"Target count: {args.count}")
    print(f"Data source: {args.source}")
    print(f"PostgreSQL: {DATABASE_URL.split('@')[1] if '@' in DATABASE_URL else DATABASE_URL}")
    print(f"OpenSearch: {OPENSEARCH_URL}")
    print("=" * 60)

    # Connect to PostgreSQL
    db_config = parse_database_url(DATABASE_URL)
    conn = psycopg2.connect(**db_config)
    print("Connected to PostgreSQL")

    # Ensure tables/indexes exist
    ensure_postgres_table(conn)
    ensure_opensearch_index()

    # Clear existing data if requested
    if args.clear:
        print("Clearing existing data...")
        with conn.cursor() as cur:
            cur.execute("DELETE FROM memory_index")
            conn.commit()
        requests.delete(f"{OPENSEARCH_URL}/{OPENSEARCH_INDEX}")
        ensure_opensearch_index()
        print("Data cleared")

    # Collect memories from various sources
    memories = []

    if args.source in ("all", "quotes", "mixed"):
        try:
            print("Fetching quotes...")
            quotes = list(download_quotes())
            memories.extend(quotes)
            print(f"  Loaded {len(quotes)} quotes")
        except Exception as e:
            print(f"  Warning: Failed to fetch quotes: {e}")

    if args.source in ("all", "mixed"):
        print("Adding programming wisdom...")
        wisdom = list(download_programming_wisdom())
        memories.extend(wisdom)
        print(f"  Added {len(wisdom)} wisdom entries")

        print("Adding tech facts...")
        facts = list(download_tech_facts())
        memories.extend(facts)
        print(f"  Added {len(facts)} facts")

        print("Adding life tips...")
        tips = list(download_life_tips())
        memories.extend(tips)
        print(f"  Added {len(tips)} tips")

    # Fill remaining with synthetic data
    remaining = args.count - len(memories)
    if remaining > 0 and args.source in ("all", "synthetic", "mixed"):
        print(f"Generating {remaining} synthetic memories...")
        synthetic = list(generate_synthetic_memories(remaining))
        memories.extend(synthetic)
        print(f"  Generated {len(synthetic)} synthetic entries")

    # Shuffle and limit to requested count
    random.shuffle(memories)
    memories = memories[:args.count]

    print(f"\nInserting {len(memories)} memories...")

    inserted = 0
    errors = 0

    for i, memory in enumerate(memories):
        try:
            insert_memory(conn, OPENSEARCH_URL, memory)
            inserted += 1

            if (i + 1) % 100 == 0:
                conn.commit()
                print(f"  Progress: {i + 1}/{len(memories)} ({inserted} inserted, {errors} errors)")

        except Exception as e:
            errors += 1
            if errors <= 5:
                print(f"  Error inserting memory: {e}")
            elif errors == 6:
                print("  (suppressing further error messages)")

    # Final commit
    conn.commit()
    conn.close()

    # Refresh OpenSearch index
    requests.post(f"{OPENSEARCH_URL}/{OPENSEARCH_INDEX}/_refresh")

    print("=" * 60)
    print(f"Done! Inserted {inserted} memories ({errors} errors)")
    print("=" * 60)

    # Show sample search
    print("\nSample search for 'programming':")
    search_resp = requests.post(
        f"{OPENSEARCH_URL}/{OPENSEARCH_INDEX}/_search",
        json={
            "size": 3,
            "query": {"multi_match": {"query": "programming", "fields": ["content", "tags"]}}
        }
    )
    if search_resp.status_code == 200:
        hits = search_resp.json().get("hits", {}).get("hits", [])
        for hit in hits:
            src = hit["_source"]
            print(f"  - [{src.get('importance_score', 0):.1f}] {src.get('content', '')[:80]}...")

    return 0


if __name__ == "__main__":
    sys.exit(main())
