from sqlalchemy import Boolean, Column, Integer, String

from database import Base


CHALLENGE_COLUMNS = {
    "consumed": "BOOLEAN NOT NULL DEFAULT 1",
    "failed_attempts": "INTEGER NOT NULL DEFAULT 0",
    "failure_window": "INTEGER NOT NULL DEFAULT 0",
}


class FactoryResetChallenge(Base):
    __tablename__ = "factory_reset_challenges"

    user_id = Column(Integer, primary_key=True)
    challenge_id = Column(String(32), nullable=False)
    owner = Column(String(64), nullable=False)
    answer_digest = Column(String(64), nullable=False)
    issued_at = Column(Integer, nullable=False)
    consumed = Column(Boolean, nullable=False, default=False)
    failed_attempts = Column(Integer, nullable=False, default=0)
    failure_window = Column(Integer, nullable=False, default=0)


def upgrade_factory_reset_challenges(connection):
    existing = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(factory_reset_challenges)")}
    missing = CHALLENGE_COLUMNS.keys() - existing
    for column, definition in CHALLENGE_COLUMNS.items():
        if column in missing:
            connection.exec_driver_sql(f"ALTER TABLE factory_reset_challenges ADD COLUMN {column} {definition}")
    if missing:
        connection.exec_driver_sql("UPDATE factory_reset_challenges SET consumed=1")
