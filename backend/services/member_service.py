from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from models.member import Member

from schemas.member_schema import (
    MemberCreate,
    MemberUpdate,
)


def get_member_by_id(
    db: Session,
    member_id: int,
):
    return (
        db.query(Member)
        .filter(
            Member.id == member_id
        )
        .first()
    )


def get_members(
    db: Session,
    skip: int = 0,
    limit: int = 100,
):
    return (
        db.query(Member)
        .order_by(
            Member.id.asc()
        )
        .offset(skip)
        .limit(limit)
        .all()
    )


def create_member(
    db: Session,
    data: MemberCreate,
):
    member = Member(
        **data.model_dump()
    )

    try:
        db.add(member)

        db.commit()

        db.refresh(member)

        return member

    except SQLAlchemyError:
        db.rollback()

        raise


def update_member(
    db: Session,
    member: Member,
    data: MemberUpdate,
):
    changes = data.model_dump(
        exclude_unset=True
    )


    for field, value in changes.items():
        setattr(
            member,
            field,
            value,
        )


    try:
        db.commit()

        db.refresh(member)

        return member

    except SQLAlchemyError:
        db.rollback()

        raise


def delete_member(
    db: Session,
    member: Member,
):
    try:
        db.delete(member)

        db.commit()

    except SQLAlchemyError:
        db.rollback()

        raise