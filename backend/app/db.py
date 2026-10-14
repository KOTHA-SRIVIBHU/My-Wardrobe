from collections.abc import Iterator

from sqlalchemy import Engine, create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool

from .config import settings


class Base(DeclarativeBase):
    pass


def make_engine(url: str, schema: str | None = None) -> Engine:
    if url.startswith("sqlite"):
        kwargs: dict = {"connect_args": {"check_same_thread": False}}
        if url in ("sqlite://", "sqlite:///:memory:"):
            kwargs["poolclass"] = StaticPool
        engine = create_engine(url, **kwargs)

        @event.listens_for(engine, "connect")
        def _enable_foreign_keys(dbapi_conn, _record):
            dbapi_conn.execute("PRAGMA foreign_keys=ON")

        return engine
    # Small pool: free hosting runs one process, and Supabase's pooler has limited slots.
    engine = create_engine(url, pool_pre_ping=True, pool_size=5, max_overflow=5, pool_recycle=300)
    if schema:
        if not schema.replace("_", "").isalnum():
            raise ValueError("DB_SCHEMA must be letters, digits and underscores")

        @event.listens_for(engine, "connect")
        def _use_schema(dbapi_conn, _record):
            with dbapi_conn.cursor() as cur:
                cur.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
                cur.execute(f'SET search_path TO "{schema}"')
            dbapi_conn.commit()

    return engine


def add_missing_columns(engine: Engine) -> list[str]:
    """create_all() never changes existing tables. Add columns introduced by newer
    versions (always nullable) so older databases keep working without migrations."""
    insp = inspect(engine)
    added = []
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name not in existing:
                    ddl_type = col.type.compile(dialect=engine.dialect)
                    conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {ddl_type}'))
                    added.append(f"{table.name}.{col.name}")
    return added


def add_missing_indexes(engine: Engine) -> None:
    """create_all() only creates indexes with new tables; add newer ones to old tables."""
    insp = inspect(engine)
    for table in Base.metadata.sorted_tables:
        if not insp.has_table(table.name):
            continue
        existing = {i["name"] for i in insp.get_indexes(table.name)}
        for index in table.indexes:
            if index.name not in existing:
                index.create(engine)


engine = make_engine(settings.database_url, settings.db_schema)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    # Routes call db.commit() once their whole operation has succeeded; anything
    # uncommitted (e.g. after a LifecycleError) is rolled back on close.
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
